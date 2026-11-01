// Sound for recordings: the microphone on every OS, system sound by WASAPI loopback on Windows. (Linux system sound
// comes from PulseAudio/PipeWire's monitor source via ffmpeg; macOS from ScreenCaptureKit, see record.rs.)
// Each source writes a 16-bit WAV, and its start time is noted so it can be lined up with the video.

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Data, SampleFormat};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

/// Plays silence on an output device: loopback only delivers while something plays.
pub fn silence_stream(d: &cpal::Device, cfg: &cpal::SupportedStreamConfig) -> Result<cpal::Stream> {
    let s = d.build_output_stream_raw(cfg.config(), cfg.sample_format(), |data: &mut Data, _| {
        match data.sample_format() {
            SampleFormat::F32 => data.as_slice_mut::<f32>().unwrap_or(&mut []).fill(0.0),
            SampleFormat::I16 => data.as_slice_mut::<i16>().unwrap_or(&mut []).fill(0),
            SampleFormat::I32 => data.as_slice_mut::<i32>().unwrap_or(&mut []).fill(0),
            _ => {}
        }
    }, |e| log::warn!("keep-alive: {e}"), None)?;
    s.play()?;
    Ok(s)
}

pub struct Capture {
    _stream: cpal::Stream,
    _keep_alive: Option<cpal::Stream>,
    writer: Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>>>,
    /// When the first samples arrived.
    pub started: Arc<Mutex<Option<Instant>>>,
    pub path: PathBuf,
}

pub fn samples_i16(data: &Data) -> Vec<i16> {
    match data.sample_format() {
        SampleFormat::F32 => data.as_slice::<f32>().unwrap_or(&[]).iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect(),
        SampleFormat::I16 => data.as_slice::<i16>().unwrap_or(&[]).to_vec(),
        SampleFormat::I32 => data.as_slice::<i32>().unwrap_or(&[]).iter().map(|s| (s >> 16) as i16).collect(),
        SampleFormat::U16 => data.as_slice::<u16>().unwrap_or(&[]).iter().map(|s| (*s as i32 - 32768) as i16).collect(),
        SampleFormat::F64 => data.as_slice::<f64>().unwrap_or(&[]).iter().map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16).collect(),
        _ => Vec::new(),
    }
}

fn start(device: cpal::Device, cfg: cpal::SupportedStreamConfig, path: PathBuf, keep_alive: Option<cpal::Stream>) -> Result<Capture> {
    let spec = hound::WavSpec { channels: cfg.channels(), sample_rate: cfg.sample_rate(), bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let writer = Arc::new(Mutex::new(Some(hound::WavWriter::create(&path, spec)?)));
    let started = Arc::new(Mutex::new(None));
    let (w, st) = (writer.clone(), started.clone());
    let stream = device.build_input_stream_raw(cfg.config(), cfg.sample_format(), move |data: &Data, _| {
        st.lock().unwrap().get_or_insert_with(Instant::now);
        if let Some(wr) = w.lock().unwrap().as_mut() { for s in samples_i16(data) { let _ = wr.write_sample(s); } }
    }, |e| log::warn!("audio: {e}"), None)?;
    stream.play()?;
    Ok(Capture { _stream: stream, _keep_alive: keep_alive, writer, started, path })
}

impl Capture {
    pub fn microphone(path: PathBuf) -> Result<Self> {
        let d = cpal::default_host().default_input_device().context("no microphone")?;
        let cfg = d.default_input_config()?;
        start(d, cfg, path, None)
    }

    /// What the speakers play. Loopback delivers nothing while the device is silent, which would squash the gaps out
    /// of the WAV and pull the sound out of sync, so a silent output stream keeps the device ticking.
    #[cfg(windows)]
    pub fn system(path: PathBuf) -> Result<Self> {
        let d = cpal::default_host().default_output_device().context("no speakers")?;
        let cfg = d.default_output_config()?;
        let silence = silence_stream(&d, &cfg)?;
        start(d, cfg, path, Some(silence))
    }

    /// Stop and close the WAV. Returns its path and when its first sample arrived.
    pub fn finish(self) -> (PathBuf, Option<Instant>) {
        drop(self._stream);
        std::thread::sleep(std::time::Duration::from_millis(120));
        if let Some(w) = self.writer.lock().unwrap().take() { let _ = w.finalize(); }
        let t = *self.started.lock().unwrap();
        (self.path, t)
    }
}
