//! Bound all live requested Rust allocation bytes, including engine caches.
//! This is an allocation limit, not a claim about RSS or virtual address space.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

pub const LIMIT: usize = 128 * 1024 * 1024;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
pub struct Budget;
#[global_allocator]
static ALLOCATOR: Budget = Budget;

#[link(name = "kernel32")]
unsafe extern "system" { fn ExitProcess(code: u32) -> !; }
fn reserve(size: usize) {
    // No formatting, panic or heap allocation in this failure path. Exit 70 is
    // reserved for resource exhaustion; no response can claim partial success.
    let old = LIVE.fetch_update(Relaxed, Relaxed, |n| n.checked_add(size).filter(|n| *n <= LIMIT));
    let Ok(old) = old else { unsafe { ExitProcess(70) } };
    PEAK.fetch_max(old + size, Relaxed);
}
pub fn live() -> usize { LIVE.load(Relaxed) }
pub fn peak() -> usize { PEAK.load(Relaxed) }

// Safety: memory/alignment are delegated unchanged to System. Counters reserve
// before allocation; successful shrink releases only the difference. A failed
// allocation terminates the isolated worker; it cannot publish a unit.
unsafe impl GlobalAlloc for Budget {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        reserve(layout.size());
        let p = unsafe { System.alloc(layout) };
        if p.is_null() { unsafe { ExitProcess(70) } }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        reserve(layout.size());
        let p = unsafe { System.alloc_zeroed(layout) };
        if p.is_null() { unsafe { ExitProcess(70) } }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if size > layout.size() { reserve(size - layout.size()); }
        let p = unsafe { System.realloc(ptr, layout, size) };
        if p.is_null() { unsafe { ExitProcess(70) } }
        if size < layout.size() { LIVE.fetch_sub(layout.size() - size, Relaxed); }
        p
    }
}
