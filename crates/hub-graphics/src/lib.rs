//! Small GPU surfaces enhance the DOM interface; all controls remain normal HTML.
#[cfg(target_arch = "wasm32")]
mod browser {
    use wasm_bindgen::prelude::*;
    use web_sys::HtmlCanvasElement;
    use wgpu::util::DeviceExt;

    #[wasm_bindgen]
    pub struct DitherSurface {
        canvas: HtmlCanvasElement,
        surface: wgpu::Surface<'static>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        config: wgpu::SurfaceConfiguration,
        pipeline: wgpu::RenderPipeline,
        uniform: wgpu::Buffer,
        bind_group: wgpu::BindGroup,
    }
    fn js_error(error: impl std::fmt::Display) -> JsValue {
        JsValue::from_str(&error.to_string())
    }
    #[wasm_bindgen]
    impl DitherSurface {
        pub async fn create(canvas: HtmlCanvasElement) -> Result<DitherSurface, JsValue> {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::BROWSER_WEBGPU,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let surface = instance
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .map_err(js_error)?;
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    compatible_surface: Some(&surface),
                    ..Default::default()
                })
                .await
                .map_err(js_error)?;
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("Hub dither"),
                    ..Default::default()
                })
                .await
                .map_err(js_error)?;
            let mut config = surface
                .get_default_config(&adapter, 480, 380)
                .ok_or_else(|| js_error("No surface configuration"))?;
            config.alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
            canvas.set_width(config.width);
            canvas.set_height(config.height);
            surface.configure(&device, &config);
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Hub ordered dither"),
                source: wgpu::ShaderSource::Wgsl(include_str!("dither.wgsl").into()),
            });
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Frame"),
                contents: bytemuck::cast_slice(&[480f32, 380., 0., 0., 0., 0., 0., 0.]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Dither pipeline"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: config.format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Frame binding"),
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                }],
            });
            Ok(Self {
                canvas,
                surface,
                device,
                queue,
                config,
                pipeline,
                uniform,
                bind_group,
            })
        }
        pub fn render(&mut self, time: f32, width: u32, height: u32, pixel_ratio: f32, mode: f32) {
            let width = width.clamp(1, 2048);
            let height = height.clamp(1, 2048);
            if self.config.width != width || self.config.height != height {
                self.config.width = width;
                self.config.height = height;
                self.canvas.set_width(width);
                self.canvas.set_height(height);
                self.surface.configure(&self.device, &self.config);
            }
            let frame = match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame)
                | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                    self.surface.configure(&self.device, &self.config);
                    return;
                }
                _ => return,
            };
            self.queue.write_buffer(
                &self.uniform,
                0,
                bytemuck::cast_slice(&[
                    width as f32,
                    height as f32,
                    time,
                    pixel_ratio,
                    mode,
                    if self.config.format.is_srgb() { 1. } else { 0. },
                    0.,
                    0.,
                ]),
            );
            let view = frame.texture.create_view(&Default::default());
            let mut encoder = self.device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Dither pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.bind_group, &[]);
                pass.draw(0..3, 0..1);
            }
            self.queue.submit([encoder.finish()]);
            self.queue.present(frame);
        }
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn shader_is_valid_for_webgpu() {
        let shader =
            naga::front::wgsl::parse_str(include_str!("dither.wgsl")).expect("WGSL parses");
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&shader)
        .expect("WGSL validates");
    }
}
