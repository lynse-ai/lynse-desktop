//! One bounded model queue shared by Wiki compilation and graph discovery.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

pub(crate) struct Scheduler {
    slots: Arc<Semaphore>,
    capacity: usize,
    recovery: Arc<Mutex<()>>,
    limits: Mutex<(Instant, Instant)>,
}

/// Model concurrency for Wiki compilation and graph discovery. Configurable so
/// a first-run organization over hundreds of meetings is not pinned to one
/// in-flight request; the provider rate-limit recovery below still applies.
fn configured_slots() -> usize {
    std::env::var("LYNSE_WIKI_CONCURRENCY")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .map(|slots| slots.clamp(1, 8))
        .unwrap_or(4)
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::with_slots(configured_slots())
    }
}

pub(super) struct Permit {
    _slot: OwnedSemaphorePermit,
    _recovery: Option<OwnedMutexGuard<()>>,
}

impl Scheduler {
    pub fn with_slots(slots: usize) -> Self {
        let capacity = slots.max(1);
        Self {
            slots: Arc::new(Semaphore::new(capacity)),
            capacity,
            recovery: Arc::new(Mutex::new(())),
            limits: Mutex::new((Instant::now(), Instant::now())),
        }
    }

    /// Configured queue size; callers batch work in waves of this width so
    /// fan-out fills the queue without over-subscribing the model provider.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub async fn acquire(&self) -> Permit {
        let slot = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .expect("model queue stays open");
        let mut recovery = None;
        loop {
            let (until, serial_until) = *self.limits.lock().await;
            if Instant::now() < serial_until && recovery.is_none() {
                recovery = Some(self.recovery.clone().lock_owned().await);
                continue;
            }
            if Instant::now() < until {
                tokio::time::sleep(until.saturating_duration_since(Instant::now())).await;
                continue;
            }
            break;
        }
        Permit {
            _slot: slot,
            _recovery: recovery,
        }
    }

    pub async fn rate_limited(&self, seconds: u64) {
        let mut limits = self.limits.lock().await;
        let until = Instant::now() + Duration::from_secs(seconds.max(1));
        limits.0 = limits.0.max(until);
        limits.1 = limits.1.max(until + Duration::from_secs(120));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn shared_queue_is_bounded_without_holding_a_commit_lock() {
        let scheduler = Scheduler::with_slots(3);
        let a = scheduler.acquire().await;
        let b = scheduler.acquire().await;
        let c = scheduler.acquire().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), scheduler.acquire())
                .await
                .is_err()
        );
        drop(a);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), scheduler.acquire())
                .await
                .is_ok()
        );
        drop((b, c));
    }
    #[tokio::test]
    async fn recovery_mode_serializes_new_calls() {
        let scheduler = Scheduler::with_slots(3);
        scheduler.limits.lock().await.1 = Instant::now() + Duration::from_secs(60);
        let first = scheduler.acquire().await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), scheduler.acquire())
                .await
                .is_err()
        );
        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), scheduler.acquire())
                .await
                .is_ok()
        );
    }
}
