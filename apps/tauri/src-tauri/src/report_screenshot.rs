//! Main-window screenshot capture for the problem report.
//!
//! The report window is a separate webview, so the renderer cannot photograph
//! the app itself — the capture runs here, on the window the user was just
//! looking at. The JPEG is staged through the same inspiration staging
//! pipeline as pasted screenshots, so previews (`local-media://`) and issue
//! attachment both flow through one uniform path.

use crate::{write_staged_image, CommandResult};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

/// Snapshot budget, including the blocking Windows capture operation.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(6);

/// Capture the main window's content as a JPEG and stage it, returning
/// `{path, url}` where `url` is a `local-media://` preview link. Always
/// targets the `main` window — safe to call from the report window while it
/// sits in front.
#[tauri::command(async)]
pub async fn report_capture_main_screenshot(app: AppHandle) -> CommandResult<Value> {
    let (tx, rx) = std::sync::mpsc::channel();
    #[cfg(target_os = "macos")]
    {
        let initiator = app.clone();
        let error_tx = tx.clone();
        app.run_on_main_thread(move || {
            // Must not block here: the WKWebView completion handler fires on
            // the main runloop, so initiating is all this closure may do.
            if let Err(error) = initiate_main_window_snapshot(&initiator, tx) {
                log::warn!("[report-screenshot] initiation failed: {error}");
                let _ = error_tx.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let handle = app.clone();
        // PrintWindow can block. Start the receiver's timeout independently
        // so a stalled capture does not leave the report flow waiting forever.
        tauri::async_runtime::spawn_blocking(move || {
            let capture = capture_main_window_jpeg(&handle);
            let _ = tx.send(capture);
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = tx.send(Err("screenshot capture is not supported on this platform".into()));
    }

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = rx
            .recv_timeout(SNAPSHOT_TIMEOUT)
            .map_err(|_| "screenshot capture timed out".to_owned())??;
        write_staged_image(&handle, bytes, "report", "jpg")
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Encode an AppKit image snapshot into JPEG bytes. UI captures compress
/// ~10× smaller as JPEG than PNG, and the report flow values upload size
/// over pixel-perfect fidelity.
#[cfg(target_os = "macos")]
fn jpeg_bytes_from_image(image: &objc2_app_kit::NSImage) -> CommandResult<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey,
        NSImageCompressionFactor,
    };
    use objc2_foundation::{NSDictionary, NSNumber};

    let Some(tiff) = image.TIFFRepresentation() else {
        return Err("snapshot TIFF encoding failed".into());
    };
    let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else {
        return Err("snapshot bitmap decoding failed".into());
    };
    let quality = NSNumber::new_f64(0.85);
    // The properties dictionary is untyped (`AnyObject` values), so bridge
    // the retained NSNumber through a raw cast.
    let quality_ref = unsafe { &*(&*quality as *const NSNumber as *const AnyObject) };
    let properties = unsafe {
        // Reading the `NSImageCompressionFactor` extern static is unsafe too.
        NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::from_slices(
            &[NSImageCompressionFactor],
            &[quality_ref],
        )
    };
    let jpeg = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties) };
    let Some(jpeg) = jpeg else {
        return Err("snapshot JPEG encoding failed".into());
    };
    Ok(jpeg.to_vec())
}

/// Kick off a `WKWebView.takeSnapshot` for the main window, delivering JPEG
/// bytes (or the error) through `tx` once the completion handler runs on the
/// main runloop. Returns before the snapshot exists.
#[cfg(target_os = "macos")]
fn initiate_main_window_snapshot(
    app: &AppHandle,
    tx: std::sync::mpsc::Sender<CommandResult<Vec<u8>>>,
) -> CommandResult<()> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;
    use std::ptr;
    // `get_webview_window` lives on the Manager trait.
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
    if ns_window_ptr.is_null() {
        return Err("main window has no native handle".into());
    }
    let ns_window = unsafe { &*(ns_window_ptr.cast::<NSWindow>()) };
    let Some(content) = ns_window.contentView() else {
        return Err("main window has no content view".into());
    };
    let Some(webview) = find_wk_webview(&content) else {
        return Err("main window webview not found".into());
    };

    // The completion block receives (NSImage snapshot, NSError error) — two
    // object pointers, matched by raw pointers to avoid dragging NSError into
    // the feature set.
    let block = block2::RcBlock::new(move |snapshot: *mut AnyObject, _error: *mut AnyObject| {
        let result = if snapshot.is_null() {
            Err("webview snapshot failed".to_owned())
        } else {
            jpeg_bytes_from_image(unsafe { &*(snapshot.cast::<objc2_app_kit::NSImage>()) })
        };
        let _ = tx.send(result);
    });
    unsafe {
        let _: () = objc2::msg_send![
            webview,
            takeSnapshotWithConfiguration: ptr::null_mut::<AnyObject>(),
            completionHandler: &*block
        ];
    }
    Ok(())
}

/// Depth-first search of the view hierarchy for the WKWebView that hosts the
/// window's page content (wry nests it below the content view).
#[cfg(target_os = "macos")]
fn find_wk_webview(view: &objc2_app_kit::NSView) -> Option<*mut objc2::runtime::AnyObject> {
    use objc2_foundation::NSObjectProtocol;

    let webview_class = objc2::class!(WKWebView);
    if view.isKindOfClass(webview_class) {
        let pointer: *const objc2_app_kit::NSView = view;
        return Some(pointer.cast_mut().cast::<objc2::runtime::AnyObject>());
    }
    for subview in view.subviews().iter() {
        if let Some(found) = find_wk_webview(&subview) {
            return Some(found);
        }
    }
    None
}

/// Windows capture: `PrintWindow` with `PW_RENDERFULLCONTENT` renders the
/// client area into a memory DC. GDI hands us BGRA pixels to encode as JPEG.
#[cfg(target_os = "windows")]
fn capture_main_window_jpeg(app: &AppHandle) -> CommandResult<Vec<u8>> {
    use std::io::Cursor;

    use tauri::Manager;
    use windows::Win32::Foundation::RECT;
    // windows-rs files PrintWindow under Storage::Xps (user32 metadata
    // quirk), but keeps PW_RENDERFULLCONTENT in WindowsAndMessaging as a
    // bare u32.
    use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PW_CLIENTONLY, PrintWindow};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetWindowDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, PW_RENDERFULLCONTENT};

    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect)
            .map_err(|error| format!("main window rect unavailable: {error}"))?;
        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        if width == 0 || height == 0 {
            return Err("main window has no visible content".into());
        }

        let hdc_window = GetWindowDC(Some(hwnd));
        if hdc_window.is_invalid() {
            return Err("main window device context unavailable".into());
        }
        let hdc_memory = CreateCompatibleDC(Some(hdc_window));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height = top-down rows, matching the encoder's row order.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(Some(hdc_memory), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|error| format!("capture bitmap allocation failed: {error}"));
        if let Err(error) = dib {
            let _ = DeleteDC(hdc_memory);
            let _ = ReleaseDC(Some(hwnd), hdc_window);
            return Err(error);
        }
        let dib = dib.unwrap();
        let previous = SelectObject(hdc_memory, dib.into());

        let flags = PRINT_WINDOW_FLAGS(PW_CLIENTONLY.0 | PW_RENDERFULLCONTENT);
        let printed = PrintWindow(hwnd, hdc_memory, flags).as_bool();
        let mut result: CommandResult<Vec<u8>> = if printed {
            let stride = width as usize * 4;
            let raw =
                std::slice::from_raw_parts(bits as *const u8, stride * height as usize);
            let mut rgba = raw.to_vec();
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2); // BGRA → RGBA
            }
            match image::RgbaImage::from_raw(width as u32, height as u32, rgba) {
                Some(frame) => {
                    // JPEG at quality 85: UI captures compress ~10× smaller
                    // than PNG, keeping the report upload lightweight.
                    let rgb = image::DynamicImage::ImageRgba8(frame).to_rgb8();
                    let mut jpeg = Cursor::new(Vec::new());
                    let mut encoder =
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
                    rgb.write_with_encoder(encoder)
                        .map_err(|error| format!("screenshot JPEG encoding failed: {error}"))?;
                    Ok(jpeg.into_inner())
                }
                None => Err("screenshot frame decoding failed".into()),
            }
        } else {
            Err("PrintWindow failed for the main window".into())
        };

        SelectObject(hdc_memory, previous);
        let _ = DeleteObject(dib.into());
        let _ = DeleteDC(hdc_memory);
        let _ = ReleaseDC(Some(hwnd), hdc_window);
        result
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_main_window_jpeg(_app: &AppHandle) -> CommandResult<Vec<u8>> {
    Err("screenshot capture is not supported on this platform".into())
}
