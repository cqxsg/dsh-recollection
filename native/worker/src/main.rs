mod budget;
use std::collections::VecDeque;
use std::io::{self, Read, Write, Cursor};
use std::time::Instant;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, MmapChoice, SearcherBuilder};
use grep_printer::JSONBuilder;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

const PROTOCOL: u32 = 1;
const SOURCE: &str = "e89fff89ac9af12e8d4ce9d5fd07beb408ca730f";
const MAX_HEADER: usize = 65536;
const MAX_INPUT: usize = 64 * 1024 * 1024;
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_SPANS: usize = 65536;
const CACHE: usize = 4;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32, request: u64, query: String, unit: String, field: String,
    patterns: Vec<String>, fixed: bool, case_sensitive: bool,
    input_bytes: usize, input_sha256: String,
}
#[derive(PartialEq, Eq)]
struct Key { patterns: Vec<String>, fixed: bool, case_sensitive: bool }
#[derive(Serialize)]
struct Span { start: usize, end: usize, sha256: String }
// Ignore large printer text fields without allocating them a second time.
#[derive(Deserialize)]
struct Event { #[serde(rename = "type")] kind: String, data: Data }
#[derive(Deserialize)]
struct Data { absolute_offset: Option<usize>, submatches: Option<Vec<Submatch>> }
#[derive(Deserialize)]
struct Submatch { start: usize, end: usize }

#[derive(Default)]
struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_OUTPUT.saturating_sub(self.0.len()) {
            return Err(io::Error::other("worker output limit"));
        }
        self.0.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn send(out: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let mut bytes = Bounded::default();
    serde_json::to_writer(&mut bytes, value)?;
    out.write_all(&(bytes.0.len() as u32).to_be_bytes())?;
    out.write_all(&bytes.0)?; out.flush()
}
fn error(out: &mut impl Write, request: &Request, code: &str, message: &str) -> io::Result<()> {
    send(out, &json!({"protocol":PROTOCOL, "request":request.request, "query":request.query,
        "unit":request.unit, "field":request.field, "input_bytes":request.input_bytes,
        "input_sha256":request.input_sha256, "complete":false, "code":code, "message":message}))
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn ExitProcess(code: u32) -> !;
}
fn watch_parent() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--parent-pid" { return Err(io::Error::other("explicit parent PID required")); }
    let pid: u32 = args[2].parse().map_err(io::Error::other)?;
    // Retain the actual process object, not subsequent PID lookups. Parent
    // disappearance interrupts even CPU-bound compilation/searching.
    let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
    if handle == 0 { return Err(io::Error::last_os_error()); }
    std::thread::spawn(move || {
        let result = unsafe { WaitForSingleObject(handle, u32::MAX) };
        unsafe { CloseHandle(handle); ExitProcess(if result == 0 { 71 } else { 72 }) }
    });
    Ok(())
}
fn run() -> io::Result<()> {
    watch_parent()?;
    let mut input = io::stdin().lock(); let mut out = io::stdout().lock();
    send(&mut out, &json!({"protocol":PROTOCOL, "kind":"ready", "build":env!("DSH_WORKER_BUILD"),
        "source":SOURCE,"rg":"15.2.0","pid":std::process::id(),
        "limits":{"header":MAX_HEADER,"input":MAX_INPUT,"output":MAX_OUTPUT,"spans":MAX_SPANS,"cache":CACHE,"allocation":budget::LIMIT}}))?;
    let mut cache: VecDeque<(Key, RegexMatcher)> = VecDeque::new();
    let mut previous = 0_u64;
    loop {
        let mut len = [0; 4];
        match input.read(&mut len[..1])? { 0 => return Ok(()), _ => input.read_exact(&mut len[1..])? }
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_HEADER { return Err(io::Error::other("invalid header length")); }
        let mut header = vec![0; len]; input.read_exact(&mut header)?;
        let request: Request = serde_json::from_slice(&header)?;
        if request.protocol != PROTOCOL || request.request <= previous || request.query.len() > 128
            || request.unit.len() > 1024 || request.field.len() > 4096 || request.patterns.is_empty()
            || request.input_bytes > MAX_INPUT {
            return Err(io::Error::other("invalid request identity or bounds"));
        }
        previous = request.request;
        let read_started = Instant::now();
        let mut body = vec![0; request.input_bytes]; input.read_exact(&mut body)?;
        if hash(&body) != request.input_sha256 || std::str::from_utf8(&body).is_err() {
            return Err(io::Error::other("input digest/encoding mismatch"));
        }
        let input_ms = read_started.elapsed().as_secs_f64() * 1000.0;
        let mut patterns = Vec::new();
        for p in &request.patterns { if !patterns.contains(p) { patterns.push(p.clone()); } }
        let key = Key { patterns, fixed: request.fixed, case_sensitive: request.case_sensitive };
        let compile_started = Instant::now();
        let (entry, compiled) = if let Some(at) = cache.iter().position(|(k, _)| *k == key) {
            (cache.remove(at).unwrap(), false)
        } else {
            if cache.len() >= CACHE { cache.pop_front(); }
            let mut builder = RegexMatcherBuilder::new();
            builder.multi_line(true).unicode(true).octal(false).fixed_strings(key.fixed)
                .case_insensitive(!key.case_sensitive).dot_matches_new_line(false);
            match builder.build_many(&key.patterns) {
                Ok(matcher) => ((key, matcher), true),
                Err(err) => {
                    let message = err.to_string();
                    error(&mut out, &request, if message.contains("regex parse error") { "invalid_pattern" } else { "worker_failed" }, &message)?;
                    continue;
                }
            }
        };
        let compile_ms = if compiled { compile_started.elapsed().as_secs_f64() * 1000.0 } else { 0.0 };
        cache.push_back(entry); let matcher = &cache.back().unwrap().1;
        let scan_started = Instant::now();
        let mut searcher = SearcherBuilder::new().line_number(true).multi_line(true)
            .line_terminator(grep_matcher::LineTerminator::byte(b'\n')).memory_map(MmapChoice::never())
            .binary_detection(BinaryDetection::none()).bom_sniffing(false).build();
        let mut printer = JSONBuilder::new().build(Bounded::default());
        let mut sink = printer.sink_with_path(matcher, "<stdin>");
        if let Err(err) = searcher.search_reader(matcher, Cursor::new(&body), &mut sink) {
            error(&mut out, &request, "worker_resource_limit", &err.to_string())?; continue;
        }
        let stats = sink.stats().clone(); drop(sink);
        if stats.bytes_searched() != body.len() as u64 || stats.searches() != 1 {
            return Err(io::Error::other("incomplete search statistics"));
        }
        let output = printer.into_inner().0;
        let mut spans = Vec::new(); let mut limited = false;
        let mut began = 0; let mut ended = 0;
        for line in output.split(|b| *b == b'\n').filter(|b| !b.is_empty()) {
            let event: Event = serde_json::from_slice(line)?;
            if event.kind == "begin" { began += 1; continue; }
            if event.kind == "end" { ended += 1; continue; }
            if event.kind != "match" || began != 1 || ended != 0 { return Err(io::Error::other("invalid printer event order")); }
            let offset = event.data.absolute_offset.ok_or_else(|| io::Error::other("missing offset"))?;
            for m in event.data.submatches.ok_or_else(|| io::Error::other("missing submatches"))? {
                if spans.len() == MAX_SPANS { limited = true; break; }
                let start = offset.checked_add(m.start).ok_or_else(|| io::Error::other("offset overflow"))?;
                let end = offset.checked_add(m.end).ok_or_else(|| io::Error::other("offset overflow"))?;
                if start > end || end > body.len() { return Err(io::Error::other("invalid match range")); }
                spans.push(Span { start, end, sha256: hash(&body[start..end]) });
            }
            if limited { break; }
        }
        if limited { error(&mut out, &request, "worker_resource_limit", "worker span limit")?; continue; }
        if began != ended || began > 1 || stats.searches_with_match() != began {
            return Err(io::Error::other("incomplete printer lifecycle"));
        }
        let scan_ms = scan_started.elapsed().as_secs_f64() * 1000.0;
        send(&mut out, &json!({"protocol":PROTOCOL,"request":request.request,"query":request.query,
            "unit":request.unit,"field":request.field,"input_bytes":request.input_bytes,"input_sha256":request.input_sha256,
            "complete":true,"spans":spans,"begin":began,"end":ended,"matches":stats.matches(),"searches":stats.searches(),
            "bytes_searched":stats.bytes_searched(),"searches_with_match":stats.searches_with_match(),
            "compiled":compiled,"compile_ms":compile_ms,"input_ms":input_ms,"scan_and_encode_ms":scan_ms,
            "printer_bytes":output.len(),"cache_entries":cache.len(),"allocated_bytes":budget::live(),"peak_allocated_bytes":budget::peak()}))?;
    }
}
fn main() { if let Err(err) = run() { eprintln!("worker protocol/search failure: {err}"); std::process::exit(2); } }
