//! Process-tree resource sampling for the compact RAM/CPU indicator.

use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStats {
    /// Private working-set memory across Terminion and its WebView2 helpers.
    pub ram_mb: f64,
    /// CPU usage across the tree, normalised to all logical processors.
    pub cpu_percent: f64,
    pub process_count: usize,
}

pub struct ProcessMonitor {
    state: Mutex<CpuState>,
    cpu_count: f64,
}

#[derive(Default)]
struct CpuState {
    ticks: std::collections::HashMap<u32, u64>,
    sampled_at: Option<std::time::Instant>,
}

impl ProcessMonitor {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CpuState::default()),
            cpu_count: std::thread::available_parallelism()
                .map(|count| count.get() as f64)
                .unwrap_or(1.0),
        }
    }

    #[cfg(windows)]
    pub fn sample(&self) -> ProcessStats {
        use std::collections::{HashMap, HashSet};
        use std::mem::{size_of, zeroed};
        use std::time::Instant;

        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
        };
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
        };

        let root = std::process::id();
        let mut processes: Vec<(u32, u32)> = Vec::new();

        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot != INVALID_HANDLE_VALUE {
                let mut entry = PROCESSENTRY32W {
                    dwSize: size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                if Process32FirstW(snapshot, &mut entry) != 0 {
                    loop {
                        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
                        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
                        if Process32NextW(snapshot, &mut entry) == 0 {
                            break;
                        }
                    }
                }
                CloseHandle(snapshot);
            }
        }

        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (pid, parent) in &processes {
            children.entry(*parent).or_default().push(*pid);
        }
        let mut ids = HashSet::new();
        let mut stack = vec![root];
        while let Some(pid) = stack.pop() {
            if !ids.insert(pid) {
                continue;
            }
            if let Some(next) = children.get(&pid) {
                stack.extend(next.iter().copied());
            }
        }

        let mut ram_bytes: u64 = 0;
        let mut ticks: HashMap<u32, u64> = HashMap::new();
        let mut process_count = 0usize;

        for pid in &ids {
            unsafe {
                let handle =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, *pid);
                if handle.is_null() {
                    continue;
                }
                process_count += 1;

                let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = zeroed();
                counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
                if GetProcessMemoryInfo(
                    handle,
                    &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                    counters.cb,
                ) != 0
                {
                    // EX2 gives the Task Manager "Memory" figure: private resident
                    // pages. Older systems may leave it at zero; fall back to commit.
                    let private = if counters.PrivateWorkingSetSize > 0 {
                        counters.PrivateWorkingSetSize
                    } else {
                        counters.PrivateUsage
                    };
                    ram_bytes = ram_bytes.saturating_add(private as u64);
                }

                let mut created: FILETIME = zeroed();
                let mut exited: FILETIME = zeroed();
                let mut kernel: FILETIME = zeroed();
                let mut user: FILETIME = zeroed();
                if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0 {
                    let filetime = |value: FILETIME| {
                        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
                    };
                    ticks.insert(*pid, filetime(kernel) + filetime(user));
                }

                CloseHandle(handle);
            }
        }

        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        let elapsed = state
            .sampled_at
            .map(|last| now.duration_since(last).as_secs_f64())
            .unwrap_or(0.0);
        let delta: u64 = ticks
            .iter()
            .filter_map(|(pid, current)| {
                state
                    .ticks
                    .get(pid)
                    .map(|previous| current.saturating_sub(*previous))
            })
            .sum();
        let cpu_percent = if elapsed >= 0.2 {
            // FILETIME ticks are 100 ns each.
            (delta as f64 / 10_000_000.0 / elapsed / self.cpu_count * 100.0).max(0.0)
        } else {
            0.0
        };
        state.ticks = ticks;
        state.sampled_at = Some(now);

        ProcessStats {
            ram_mb: ram_bytes as f64 / (1024.0 * 1024.0),
            cpu_percent,
            process_count,
        }
    }

    #[cfg(not(windows))]
    pub fn sample(&self) -> ProcessStats {
        ProcessStats {
            ram_mb: 0.0,
            cpu_percent: 0.0,
            process_count: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ProcessMonitor;

    #[test]
    fn samples_the_current_process_tree() {
        let monitor = ProcessMonitor::new();
        let first = monitor.sample();
        assert!(first.ram_mb > 0.0, "private memory should be sampled");
        assert!(
            first.process_count >= 1,
            "the current process should be found"
        );
        std::thread::sleep(std::time::Duration::from_millis(250));
        let second = monitor.sample();
        assert!(second.ram_mb > 0.0);
    }
}
