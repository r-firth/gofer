struct Frame { size: vec2<f32>, time: f32, pixel_ratio: f32, instrument: vec4<f32> }
@group(0) @binding(0) var<uniform> frame: Frame;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>, 3>(vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
    return vec4(positions[index], 0., 1.);
}
fn line(distance: f32, width: f32) -> f32 {
    return 1. - smoothstep(width, width + .065, abs(distance));
}
fn box(p: vec2<f32>, size: vec2<f32>) -> f32 {
    return max(abs(p.x) - size.x, abs(p.y) - size.y);
}
// Analytic activity instruments. Mode numbers and fields match signal-field.ts.
// These communicate the type of work, never an invented progress estimate.
fn density(p: vec2<f32>) -> f32 {
    let x = p.x; let y = p.y; let t = frame.time;
    let mode = u32(frame.instrument.x);
    if mode == 6u {
        // Original sidebar wave field, sampled in normalized UV coordinates.
        let wave = .5 + sin(x * 8. - t * 1.8) * .24;
        let echo = .5 + cos(x * 11. + t * 1.2) * .2;
        let wave_distance = (y - wave) * 4.2;
        let echo_distance = (y - echo) * 6.;
        let band = exp(-wave_distance * wave_distance);
        let trail = exp(-echo_distance * echo_distance) * .55;
        let envelope = smoothstep(0., .16, x) * smoothstep(0., .08, 1. - x);
        return clamp((band + trail) * envelope * .85, 0., 1.);
    }
    if mode == 1u {
        let r = length(p);
        if r > .9 { return 0.; }
        let z = sqrt(max(0., .81 - r * r));
        let longitude = atan2(x, z) + t * .65;
        let meridian = line(sin(longitude * 3.) * max(z, .2), .025);
        let latitude = max(line(y, .015), line(abs(y) - .44, .02));
        let land = smoothstep(.25, .7, sin(longitude * 3. + y * 6.) * cos(longitude * 2. - y * 9.));
        return max(max(line(r - .86, .025), meridian * .8), max(latitude * .7, (.2 + land * .66) * z));
    }
    if mode == 2u {
        if abs(x) > 1.4 || abs(y) > .78 { return 0.; }
        let row = floor((y + .75) / .5);
        let row_y = row * .5 - .5;
        let position = fract((x + 1.4) / 2.8 - t * .28 + row * .23);
        let distance = (position - .78) * 14.;
        let head = exp(-distance * distance);
        let trail = smoothstep(.03, .72, position) * (1. - smoothstep(.77, .84, position));
        let bit = select(1., .3, u32(floor((x + 1.4) * 8. + row * 3.)) % 5u == 0u);
        return line(y - row_y, .065) * max(head, trail * bit * .72);
    }
    if mode == 3u {
        let edge = line(box(p, vec2(.62, .78)), .025);
        if abs(x) > .53 || abs(y) > .65 { return edge * .65; }
        let scan = -.65 + fract(t * .24) * 1.3;
        let row = floor((y + .6) / .3);
        let row_y = row * .3 - .45;
        let row_length = select(.22, .43, i32(row) % 2 == 0);
        let written = (1. - smoothstep(row_length, row_length + .06, x)) * smoothstep(scan - .15, scan, y);
        return max(max(edge * .65, line(y - scan, .035)), line(y - row_y, .025) * written * .7);
    }
    if mode == 4u {
        let nodes = line(box(vec2(abs(x) - 1.03, y), vec2(.26, .48)), .035);
        let cores = (1. - smoothstep(.08, .17, length(vec2(abs(x) - 1.03, y)))) * .9;
        if abs(x) > .73 { return max(nodes * .65, cores); }
        let packet = fract((x + .73) / 1.46 - t * .65);
        return max(line(y, .02) * .25, (1. - smoothstep(.05, .2, abs(packet - .5))) * line(y, .09));
    }
    if mode == 5u {
        var field = 0.;
        for (var i = 0u; i < 6u; i++) {
            let angle = f32(i) * 3.14159265 / 3.;
            let node = vec2(cos(angle) * 1.04, sin(angle) * .68);
            let distance = length(p - node);
            let strength = .4 + .6 * pow(.5 + .5 * cos(t * 2. - f32(i)), 3.);
            field = max(field, (1. - smoothstep(.06, .17, distance)) * strength);
            let along = clamp(dot(p, node) / dot(node, node), 0., 1.);
            let spoke = length(p - along * node);
            let delta = (along - fract(t * .4 - f32(i) * .14)) * 8.;
            let pulse = exp(-delta * delta);
            field = max(field, line(spoke, .012) * (.14 + pulse * .55));
        }
        return max(field, (1. - smoothstep(.09, .22, length(p))) * .9);
    }
    let angle = t * .45;
    let rotated = vec2(x * cos(angle) - y * sin(angle), x * sin(angle) + y * cos(angle));
    let orbit = max(line(length(rotated * vec2(1., 2.5)) - .78, .025), line(length(rotated * vec2(2.5, 1.)) - .78, .025));
    let core = exp(-dot(p, p) * 11.) * (.5 + sin(t * 1.8) * .12);
    return max(orbit * .75, core);
}
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let flow = frame.instrument.x == 6.;
    let pixel = select(max(1., floor(frame.pixel_ratio * 1.5 + .5)), max(1., frame.pixel_ratio) * 2., flow);
    let cell = floor(position.xy / pixel);
    let uv = (cell + .5) * pixel / frame.size;
    let p = (uv - .5) * 2. * vec2(frame.size.x / frame.size.y, 1.);
    let bayer = array<f32,16>(0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
    let index = (u32(cell.x) % 4u) + (u32(cell.y) % 4u) * 4u;
    let threshold = (bayer[index] + .5) / 16.;
    let fit = select(min(1., frame.size.x / frame.size.y / 1.55), 1., frame.instrument.x < 2. || frame.instrument.x == 6.);
    let field = density(select(p / fit, uv, flow));
    let light = smoothstep(threshold - .1, threshold + .1, field) * select(smoothstep(0., .12, field), 1., flow);
    let inset = fract(position.xy / pixel);
    let dot = (1. - step(.72, inset.x)) * (1. - step(.72, inset.y));
    let alpha = light * select(.95, .88 * dot, flow);
    // Convert only for an sRGB swapchain; unorm browser surfaces already take sRGB.
    let srgb = select(vec3(255., 164., 107.) / 255., vec3(1., .6, .373), flow);
    let color = select(srgb, pow((srgb + .055) / 1.055, vec3(2.4)), frame.instrument.y > 0.);
    return vec4(color * alpha, alpha);
}
