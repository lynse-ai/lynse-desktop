//! Stateful sample-rate converter.
//!
//! Capture callbacks deliver arbitrary chunk sizes at the device rate; a
//! per-callback linear resampler would lose the fractional sample position at
//! every chunk boundary and produce audible pitch wobble. This one keeps the
//! interpolation phase across calls, so a stream of chunks resamples exactly
//! like one contiguous buffer (modulo the interpolation itself).
//!
//! 48 kHz → 16 kHz lands on whole-number positions (step = 3.0, frac always
//! 0), which is the common Windows shared-mode case and bit-exact.

pub struct Resampler {
    in_rate: u32,
    out_rate: u32,
    /// Output positions in input-sample units, carried across calls.
    position: f64,
    /// The last input sample of the previous call, so interpolation at a
    /// chunk boundary has its left neighbour.
    history: Option<f32>,
    /// Input frames consumed (including history), for chunk position mapping.
    consumed: u64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        debug_assert!(in_rate > 0 && out_rate > 0);
        Self {
            in_rate,
            out_rate,
            position: 0.0,
            history: None,
            consumed: 0,
        }
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    /// Push one chunk of contiguous input, resample, and drain complete
    /// output samples. The final output samples that would need samples past
    /// the end of *this* chunk wait for the next call — call
    /// [`flush`](Self::flush) at end of stream.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.in_rate == self.out_rate {
            self.consumed += input.len() as u64;
            return input.to_vec();
        }
        let step = f64::from(self.in_rate) / f64::from(self.out_rate);
        let mut output = Vec::new();
        // Index into the virtual stream: position + consumed counts from the
        // very first sample; virtual[v] = input[v - consumed] or history.
        loop {
            let index = self.position.floor() as u64;
            let frac = (self.position - index as f64) as f32;
            let next_index = index + 1;
            // Both neighbours must be inside this call's window (history
            // covers index == consumed-1); otherwise wait for more input.
            if next_index >= self.consumed + input.len() as u64 {
                break;
            }
            let a = self.virtual_sample(index, input);
            let b = self.virtual_sample(next_index, input);
            output.push(a + (b - a) * frac);
            self.position += step;
        }
        self.consumed += input.len() as u64;
        if let Some(last) = input.last() {
            self.history = Some(*last);
        }
        output
    }

    /// Emit the tail outputs that were waiting for samples past the end of
    /// the stream (interpolated against zeros).
    pub fn flush(&mut self) -> Vec<f32> {
        if self.in_rate == self.out_rate {
            return Vec::new();
        }
        let step = f64::from(self.in_rate) / f64::from(self.out_rate);
        let mut output = Vec::new();
        while (self.position.floor() as u64) < self.consumed {
            let index = self.position.floor() as u64;
            let frac = (self.position - index as f64) as f32;
            let a = self.virtual_sample(index, &[]);
            let b = self.virtual_sample(index + 1, &[]);
            output.push(a + (b - a) * frac);
            self.position += step;
        }
        output
    }

    fn virtual_sample(&self, index: u64, input: &[f32]) -> f32 {
        let consumed_start = self.consumed;
        if index < consumed_start {
            // Everything before this call's window collapses into the single
            // history sample (index == consumed_start - 1).
            self.history.unwrap_or(0.0)
        } else {
            let offset = (index - consumed_start) as usize;
            input.get(offset).copied().unwrap_or(0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_when_rates_match() {
        let mut resampler = Resampler::new(48_000, 48_000);
        assert_eq!(resampler.process(&[0.1, 0.2, 0.3]), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn three_to_one_decimation_is_exact_and_chunk_agnostic() {
        // One contiguous buffer…
        let input: Vec<f32> = (0..9_000).map(|i| (i as f32) * 0.001).collect();
        let mut whole = Resampler::new(48_000, 16_000);
        let expected = whole.process(&input);

        // …must equal the same data split into odd-sized chunks.
        let mut chunked = Resampler::new(48_000, 16_000);
        let mut actual = Vec::new();
        let mut offset = 0;
        for size in [1usize, 511, 1024, 7, 3000, 442] {
            let end = (offset + size).min(input.len());
            actual.extend(chunked.process(&input[offset..end]));
            offset = end;
        }
        actual.extend(chunked.process(&input[offset..]));
        assert_eq!(actual.len(), expected.len());
        for (a, e) in actual.iter().zip(expected.iter()) {
            assert!((a - e).abs() < 1e-6, "{a} vs {e}");
        }
    }

    #[test]
    fn fraction_rate_keeps_phase_across_chunks() {
        let mut resampler = Resampler::new(44_100, 48_000);
        let sine: Vec<f32> = (0..44_100)
            .map(|i| (f64::from(i) * 440.0 * 2.0 * std::f64::consts::PI / 44_100.0).sin() as f32)
            .collect();
        let mut out = Vec::new();
        for chunk in sine.chunks(1000) {
            out.extend(resampler.process(chunk));
        }
        out.extend(resampler.flush());
        // 1 s at 44.1 kHz → 1 s at 48 kHz, ±1 sample of rounding.
        assert!((out.len() as i64 - 48_000).abs() <= 2, "len={}", out.len());
        // Continuity: the resampled sine must not lose amplitude at chunk
        // boundaries (a per-callback resampler would dip).
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.95, "resampled peak {peak}");
    }

    #[test]
    fn flush_drains_the_tail() {
        let mut resampler = Resampler::new(48_000, 16_000);
        // 3:1: each full input triple produces exactly one output sample.
        let mut out = resampler.process(&[1.0, 2.0, 3.0]);
        assert_eq!(out, vec![1.0]);
        out = resampler.process(&[4.0, 5.0, 6.0]);
        assert_eq!(out, vec![4.0]);
        // Whole-number ratio leaves no fractional tail to flush.
        assert!(resampler.flush().is_empty());
    }
}
