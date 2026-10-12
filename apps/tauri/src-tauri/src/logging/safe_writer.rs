//! Logging output must never turn an I/O failure into an application panic.
use std::io::{self, Write};

pub(super) struct BestEffortWriter<W>(pub(super) W);

impl<W: Write> Write for BestEffortWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = self.0.write_all(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = self.0.flush();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct BrokenPipe;
    impl Write for BrokenPipe {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "closed launch pipe",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "closed launch pipe",
            ))
        }
    }

    #[test]
    fn closed_output_pipe_does_not_propagate_write_or_flush_errors() {
        let mut writer = BestEffortWriter(BrokenPipe);
        assert_eq!(writer.write(b"startup log").unwrap(), 11);
        writer.flush().unwrap();
    }

    #[test]
    fn healthy_output_is_preserved() {
        let mut writer = BestEffortWriter(Vec::new());
        writer.write_all(b"startup log").unwrap();
        writer.flush().unwrap();
        assert_eq!(writer.0, b"startup log");
    }
}
