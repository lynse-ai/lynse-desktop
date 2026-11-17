//! nusb transport for the recording card: enumeration, vendor-interface
//! claim, control-transfer password handshake and bulk frame I/O.
//!
//! All transfer layouts were captured from the vendor WebUSB SDK running
//! against a mock device (see webusb-protocol-notes.md).

use std::time::Duration;

use nusb::transfer::{Buffer, ControlIn, ControlOut, ControlType, In, Out, Recipient};
use nusb::{DeviceInfo, Interface, MaybeFuture};

use super::protocol::{frame_prefix, parse_response, DeviceResponse};

pub const DEFAULT_VENDOR_ID: u16 = 0x3654;
pub const DEFAULT_PRODUCT_ID: u16 = 0x4155;

const CONTROL_REQUEST_OUT: u8 = 0x12;
const CONTROL_REQUEST_IN: u8 = 0x13;
const BULK_ENDPOINT_OUT: u8 = 0x01;
const BULK_ENDPOINT_IN: u8 = 0x82; // 2 | 0x80 (IN direction)
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("recording card not found (VID 0x{vid:04x} / PID 0x{pid:04x})")]
    NotFound { vid: u16, pid: u16 },
    #[error("USB error: {0}")]
    Usb(String),
    #[error("password handshake failed: {0}")]
    Auth(String),
    #[error("transfer error: {0}")]
    Transfer(String),
    #[error("device disconnected")]
    Disconnected,
}

impl From<nusb::Error> for DeviceError {
    fn from(value: nusb::Error) -> Self {
        DeviceError::Usb(value.to_string())
    }
}

impl From<nusb::transfer::TransferError> for DeviceError {
    fn from(value: nusb::transfer::TransferError) -> Self {
        DeviceError::Transfer(value.to_string())
    }
}

/// Find the first recording card matching VID/PID.
pub fn find_device(vendor_id: u16, product_id: u16) -> Result<DeviceInfo, DeviceError> {
    let devices = nusb::list_devices()
        .wait()
        .map_err(|e| DeviceError::Usb(e.to_string()))?;
    for device in devices {
        if device.vendor_id() == vendor_id && device.product_id() == product_id {
            return Ok(device);
        }
    }
    Err(DeviceError::NotFound {
        vid: vendor_id,
        pid: product_id,
    })
}

/// An opened, authenticated recording card. Owns the claimed interface for
/// its whole lifetime; dropping it releases the interface.
pub struct CardDevice {
    interface: Interface,
    pub vendor_id: u16,
    pub product_id: u16,
    authenticated: bool,
}

impl CardDevice {
    /// Open the device, claim its vendor interface and run the password
    /// control-transfer handshake. Captured sequence:
    ///   1. set_configuration(1) + claim_interface(0)
    ///   2. drain any startup bulk-IN noise (best effort)
    ///   3. control OUT request=0x12, recipient=interface, data=UTF-8(password)
    ///   4. control IN  request=0x13, recipient=interface -> 0x01 = success
    pub async fn open_and_authenticate(
        info: &DeviceInfo,
        password: &str,
    ) -> Result<Self, DeviceError> {
        let device = info.open().await?;
        device.set_configuration(1).await?;
        let interface = device.claim_interface(0).await?;

        // Drain startup noise before the handshake. The SDK reads a few
        // frames the device emits on open; tolerate a short quiet wait here.
        let _ = Self::drain_quiet(&interface).await;

        interface
            .control_out(ControlOut {
                control_type: ControlType::Standard,
                recipient: Recipient::Interface,
                request: CONTROL_REQUEST_OUT,
                value: 0,
                index: 0,
                data: password.as_bytes(),
            }, IO_TIMEOUT)
            .await?;

        let result = interface
            .control_in(ControlIn {
                control_type: ControlType::Standard,
                recipient: Recipient::Interface,
                request: CONTROL_REQUEST_IN,
                value: 0,
                index: 0,
                length: 1,
            }, IO_TIMEOUT)
            .await?;

        if result.first() != Some(&0x01) {
            return Err(DeviceError::Auth(
                "口令校验失败，已断开连接".to_string(),
            ));
        }

        Ok(Self {
            interface,
            vendor_id: info.vendor_id(),
            product_id: info.product_id(),
            authenticated: true,
        })
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    async fn drain_quiet(interface: &Interface) -> Result<(), DeviceError> {
        // Best-effort short read of startup frames; a timeout here is normal
        // and must not fail the connection.
        let mut ep = interface
            .endpoint::<nusb::transfer::Bulk, In>(BULK_ENDPOINT_IN)
            .map_err(|e| DeviceError::Usb(e.to_string()))?;
        let mut buf = Buffer::new(64);
        ep.submit(buf);
        let _ = ep.next_complete().await.into_result();
        Ok(())
    }

    /// Write a raw frame to the vendor bulk OUT endpoint.
    pub async fn write_frame(&self, frame: &[u8]) -> Result<usize, DeviceError> {
        let mut ep = self
            .interface
            .endpoint::<nusb::transfer::Bulk, Out>(BULK_ENDPOINT_OUT)
            .map_err(|e| DeviceError::Usb(e.to_string()))?;
        let mut buf = Buffer::new(frame.len());
        buf.extend_from_slice(frame);
        let len = buf.len();
        ep.submit(buf);
        let completed = ep.next_complete().await.into_result()?;
        Ok(completed.len())
    }

    /// Read one raw bulk-IN frame (up to 4096 bytes, matching the SDK).
    pub async fn read_frame(&self) -> Result<Vec<u8>, DeviceError> {
        let mut ep = self
            .interface
            .endpoint::<nusb::transfer::Bulk, In>(BULK_ENDPOINT_IN)
            .map_err(|e| DeviceError::Usb(e.to_string()))?;
        let mut buf = Buffer::new(4096);
        ep.submit(buf);
        let completed = ep.next_complete().await.into_result()?;
        Ok(completed.into_vec())
    }

    /// Send a command and read its matching response frame, skipping
    /// unrelated frames until the expected command arrives or timeout.
    /// Every skipped/unparsed frame is logged so a real-device capture in
    /// the app log pins down the actual frame prefix and shapes.
    pub async fn exchange(&self, command: &str, frame: &[u8]) -> Result<DeviceResponse, DeviceError> {
        self.write_frame(frame).await?;
        let deadline = std::time::Instant::now() + IO_TIMEOUT;
        let mut seen = 0usize;
        while std::time::Instant::now() < deadline {
            let raw = self.read_frame().await?;
            seen += 1;
            match parse_response(&raw, frame_prefix()) {
                Some(response) => {
                    if response.command == command {
                        return Ok(response);
                    }
                    log::info!(
                        "[recording-card] frame cmd={} (want {command}), fields={:?}",
                        response.command,
                        response.fields
                    );
                }
                None => {
                    let text = super::frames::decode_frame_text(&raw);
                    let head: String = text.chars().take(160).collect();
                    log::info!(
                        "[recording-card] unparsed frame #{seen} ({} bytes): {:?}",
                        raw.len(),
                        head
                    );
                }
            }
        }
        log::warn!(
            "[recording-card] exchange timeout for {command} after {seen} frames — frame prefix likely differs from {:?}",
            frame_prefix()
        );
        Err(DeviceError::Transfer(format!(
            "no response for command {command}"
        )))
    }
}
