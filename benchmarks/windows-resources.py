"""Read-only Windows experiment sampler. One retained handle per observed process identity."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
import queue
import sys
import threading
import time

if sys.platform != 'win32':
    raise SystemExit('Windows x64 resource sampling only')

class Memory(c.Structure):
    _fields_ = [('cb', w.DWORD), ('PageFaultCount', w.DWORD)] + [(name, c.c_size_t) for name in
        ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage',
         'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]

k = c.WinDLL('kernel32', use_last_error=True)
k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k.OpenProcess.restype = w.HANDLE
k.CloseHandle.argtypes = [w.HANDLE]
k.GetProcessTimes.argtypes = [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4
k.GetProcessTimes.restype = w.BOOL
k.K32GetProcessMemoryInfo.argtypes = [w.HANDLE, c.POINTER(Memory), w.DWORD]
k.K32GetProcessMemoryInfo.restype = w.BOOL
k.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k.WaitForSingleObject.restype = w.DWORD

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def times(handle):
    created, exited, kernel, user = (w.FILETIME() for _ in range(4))
    if not k.GetProcessTimes(handle, c.byref(created), c.byref(exited), c.byref(kernel), c.byref(user)):
        return None
    number = lambda t: (t.dwHighDateTime << 32) | t.dwLowDateTime
    return {'creation': str(number(created)), 'kernelMs': number(kernel) / 10000, 'userMs': number(user) / 10000}

def memory(handle):
    value = Memory(); value.cb = c.sizeof(value)
    if not k.K32GetProcessMemoryInfo(handle, c.byref(value), value.cb):
        return None
    return {'rssBytes': value.WorkingSetSize, 'peakRssBytes': value.PeakWorkingSetSize}

parser = argparse.ArgumentParser()
parser.add_argument('--host', type=int, required=True)
parser.add_argument('--interval-ms', type=int, default=10)
parser.add_argument('--max-active', type=int, default=128)
args = parser.parse_args()
if not 1 <= args.interval_ms <= 1000 or not 2 <= args.max_active <= 1024:
    raise SystemExit('Invalid sampler limits')

inbox = queue.Queue(maxsize=4096)
def reader():
    try:
        for line in sys.stdin:
            if len(line) > 4096:
                inbox.put({'type': 'error', 'reason': 'oversized_control_frame'}); break
            inbox.put(json.loads(line))
    except Exception:
        inbox.put({'type': 'error', 'reason': 'invalid_control_frame'})
    finally:
        inbox.put({'type': 'stop'})
threading.Thread(target=reader, daemon=True).start()

active = {}; identities = set(); phase = 'startup'; began = time.perf_counter(); stopped = False
stats = {'registered': 0, 'opened': 0, 'openMisses': 0, 'activeLimitMisses': 0, 'duplicateIdentity': 0,
         'closed': 0, 'cpuMissing': 0, 'rssMissing': 0, 'lifetimePeakMissing': 0, 'samples': 0,
         'childCpuMs': 0, 'maxSweepMs': 0, 'maxSampleGapMs': 0, 'sampledTreePeakBytes': 0,
         'peakSample': None, 'phases': {}}

def register(index, pid, kind, label):
    if kind == 'matcher': stats['registered'] += 1
    row = {'id': index, 'pid': pid, 'kind': kind, 'phase': label, 'samples': 0,
           'sampledPeakRssBytes': None, 'observedLifetimePeakRssBytes': None, 'lifetimePeakRssBytes': None,
           'cpuMs': None, 'cpuComplete': False}
    if len(active) >= args.max_active:
        stats['activeLimitMisses'] += 1
        row['failure'] = 'active_handle_limit'; emit({'type': 'process', **row}); return
    handle = k.OpenProcess(0x1000 | 0x100000, False, pid)
    timing = times(handle) if handle else None
    if not timing:
        if handle: k.CloseHandle(handle)
        stats['openMisses'] += 1; row['failure'] = 'open_or_identity_unavailable'
        emit({'type': 'process', **row}); return
    identity = (pid, timing['creation'])
    if identity in identities:
        k.CloseHandle(handle); stats['duplicateIdentity'] += 1
        row['failure'] = 'duplicate_process_identity'; emit({'type': 'process', **row}); return
    identities.add(identity)
    row['creationFiletime'] = timing['creation']
    row['baseCpuMs'] = timing['kernelMs'] + timing['userMs'] if kind != 'matcher' else 0
    active[index] = (handle, row)
    if kind == 'matcher': stats['opened'] += 1

def finish(index, final=False):
    handle, row = active.pop(index)
    try:
        timing = times(handle)
        if timing:
            row['cpuMs'] = max(0, timing['kernelMs'] + timing['userMs'] - row.pop('baseCpuMs'))
            row['cpuComplete'] = True
        else: row.pop('baseCpuMs', None)
        mem = memory(handle)
        if mem:
            row['lifetimePeakRssBytes'] = mem['peakRssBytes']
        if row['kind'] == 'matcher':
            stats['closed'] += 1
            stats['cpuMissing'] += row['cpuMs'] is None
            stats['rssMissing'] += row['sampledPeakRssBytes'] is None
            stats['lifetimePeakMissing'] += row['lifetimePeakRssBytes'] is None
            stats['childCpuMs'] += row['cpuMs'] or 0
        row['aliveAtCaptureEnd'] = final and k.WaitForSingleObject(handle, 0) != 0
        if row['aliveAtCaptureEnd'] and row['kind'] == 'matcher': row['cpuComplete'] = False
        emit({'type': 'process', **row})
    finally:
        identities.discard((row['pid'], row['creationFiletime']))
        k.CloseHandle(handle)

register('host', args.host, 'host', 'capture')
register('observer', os.getpid(), 'observer', 'capture')
if 'host' not in active: raise SystemExit('Cannot observe Host')
emit({'type': 'ready', 'version': 1, 'pid': os.getpid(), 'intervalMs': args.interval_ms, 'python': sys.version})
next_sample = began; last_sample = began; last_report = began
try:
    while not stopped:
        # Input is bounded; each turn returns to sampling even under a producer flood.
        for _ in range(512):
            try: message = inbox.get_nowait()
            except queue.Empty: break
            if message['type'] == 'add': register(message['id'], message['pid'], 'matcher', message['phase'])
            elif message['type'] == 'phase': phase = message['phase']
            elif message['type'] == 'stop': stopped = True; break
            else: raise RuntimeError(message.get('reason', 'unknown_control_frame'))
        now = time.perf_counter()
        if now >= next_sample:
            started = now; members = []; missing = 0
            for index, (handle, row) in list(active.items()):
                if row['kind'] == 'matcher' and k.WaitForSingleObject(handle, 0) == 0:
                    finish(index); continue
                mem = memory(handle)
                if mem:
                    row['samples'] += 1
                    row['sampledPeakRssBytes'] = max(row['sampledPeakRssBytes'] or 0, mem['rssBytes'])
                    row['observedLifetimePeakRssBytes'] = max(row['observedLifetimePeakRssBytes'] or 0, mem['peakRssBytes'])
                    if row['kind'] != 'observer': members.append({'id': index, 'pid': row['pid'], 'rssBytes': mem['rssBytes']})
                elif row['kind'] != 'observer': missing += 1
            sweep_ms = (time.perf_counter() - started) * 1000
            total = sum(p['rssBytes'] for p in members)
            stats['samples'] += 1
            stats['maxSweepMs'] = max(stats['maxSweepMs'], sweep_ms)
            stats['maxSampleGapMs'] = max(stats['maxSampleGapMs'], (started - last_sample) * 1000)
            item = stats['phases'].setdefault(phase, {'samples': 0, 'sampledTreePeakBytes': 0, 'missingReadSamples': 0})
            item['samples'] += 1; item['sampledTreePeakBytes'] = max(item['sampledTreePeakBytes'], total)
            item['missingReadSamples'] += bool(missing)
            if total > stats['sampledTreePeakBytes']:
                stats['sampledTreePeakBytes'] = total
                stats['peakSample'] = {'elapsedMs': (started - began) * 1000, 'sweepMs': sweep_ms, 'phase': phase, 'members': members, 'missingReads': missing}
            last_sample = started; next_sample = started + args.interval_ms / 1000
        if now - last_report >= 1:
            emit({'type': 'progress', 'stats': stats}); last_report = now
        if not stopped: time.sleep(min(0.001, args.interval_ms / 1000))
finally:
    for index in list(active): finish(index, final=True)
    emit({'type': 'final', 'elapsedMs': (time.perf_counter() - began) * 1000, 'stats': stats})
