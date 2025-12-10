/**
 * Gaussian Splat Renderer for Three.js
 * Adapted from kishimisu/Gaussian-Splatting-WebGL
 */

import * as THREE from 'three';

const vertexShader = `
precision highp float;
attribute vec3 a_center, a_col, a_covA, a_covB;
attribute float a_opacity;
uniform float W, H, focal_x, focal_y, tan_fovx, tan_fovy;
uniform mat4 viewmatrix, projmatrix;
varying vec3 v_col;
varying vec4 v_con_o;
varying vec2 v_xy, v_pixf;

vec3 computeCov2D(vec3 mean, float cov3D[6]) {
    vec4 t = viewmatrix * vec4(mean, 1.0);
    float limx = 1.3 * tan_fovx, limy = 1.3 * tan_fovy;
    t.x = min(limx, max(-limx, t.x / t.z)) * t.z;
    t.y = min(limy, max(-limy, t.y / t.z)) * t.z;
    mat3 J = mat3(focal_x / t.z, 0.0, -(focal_x * t.x) / (t.z * t.z),
                  0.0, focal_y / t.z, -(focal_y * t.y) / (t.z * t.z), 0.0, 0.0, 0.0);
    mat3 W = mat3(viewmatrix[0][0], viewmatrix[1][0], viewmatrix[2][0],
                  viewmatrix[0][1], viewmatrix[1][1], viewmatrix[2][1],
                  viewmatrix[0][2], viewmatrix[1][2], viewmatrix[2][2]);
    mat3 T = W * J;
    mat3 Vrk = mat3(cov3D[0], cov3D[1], cov3D[2], cov3D[1], cov3D[3], cov3D[4], cov3D[2], cov3D[4], cov3D[5]);
    mat3 cov = transpose(T) * transpose(Vrk) * T;
    cov[0][0] += 0.3; cov[1][1] += 0.3;
    return vec3(cov[0][0], cov[0][1], cov[1][1]);
}

void main() {
    vec4 p_hom = projmatrix * vec4(a_center, 1.0);
    vec3 p_proj = p_hom.xyz / (p_hom.w + 1e-7);
    vec4 p_view = viewmatrix * vec4(a_center, 1.0);
    if (p_view.z > -0.2) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }

    float cov3D[6] = float[6](a_covA.x, a_covA.y, a_covA.z, a_covB.x, a_covB.y, a_covB.z);
    vec3 cov = computeCov2D(a_center, cov3D);
    float det = cov.x * cov.z - cov.y * cov.y;
    if (det == 0.0) { gl_Position = vec4(0.0, 0.0, 0.0, 1.0); return; }

    vec3 conic = vec3(cov.z, -cov.y, cov.x) / det;
    float mid = 0.5 * (cov.x + cov.z);
    float lambda1 = mid + sqrt(max(0.1, mid * mid - det));
    float lambda2 = mid - sqrt(max(0.1, mid * mid - det));
    float my_radius = ceil(3.0 * sqrt(max(lambda1, lambda2)));
    vec2 point_image = vec2(((p_proj.x + 1.0) * W - 1.0) * 0.5, ((p_proj.y + 1.0) * H - 1.0) * 0.5);
    vec2 screen_pos = point_image + my_radius * position.xy;

    v_col = a_col;
    v_con_o = vec4(conic, a_opacity);
    v_xy = point_image;
    v_pixf = screen_pos;
    gl_Position = vec4(screen_pos / vec2(W, H) * 2.0 - 1.0, 0.0, 1.0);
}`;

const fragmentShader = `
precision highp float;
varying vec3 v_col;
varying vec4 v_con_o;
varying vec2 v_xy, v_pixf;

void main() {
    vec2 d = v_xy - v_pixf;
    float power = -0.5 * (v_con_o.x * d.x * d.x + v_con_o.z * d.y * d.y) - v_con_o.y * d.x * d.y;
    if (power > 0.0) discard;
    float alpha = min(0.99, v_con_o.w * exp(power));
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(v_col * alpha, alpha);
}`;

const workerCode = `
let positions, splatCount;
self.onmessage = e => {
    if (e.data.type === 'init') {
        positions = new Float32Array(e.data.data.positions);
        splatCount = e.data.data.splatCount;
    } else if (e.data.type === 'sort') {
        const vm = e.data.data.viewMatrix;
        const depths = new Float32Array(splatCount);
        for (let i = 0; i < splatCount; i++)
            depths[i] = vm[2] * positions[i*3] + vm[6] * positions[i*3+1] + vm[10] * positions[i*3+2] + vm[14];
        const indices = new Uint32Array(splatCount);
        for (let i = 0; i < splatCount; i++) indices[i] = i;
        indices.sort((a, b) => depths[a] - depths[b]);
        self.postMessage({ indices }, [indices.buffer]);
    }
};`;

export class GaussianSplatRenderer {
    constructor(renderer, camera) {
        this.renderer = renderer;
        this.camera = camera;
        this.mesh = null;
        this.material = null;
        this.geometry = null;
        this.worker = null;
        this.isWorkerSorting = false;
        this.sortTime = 0;
        this.splatCount = 0;
        this.lastCameraMatrix = new THREE.Matrix4();
        this.positions = null;
        this.colors = null;
        this.opacities = null;
        this.cov3DsA = null;
        this.cov3DsB = null;
        this.sortedIndices = null;
    }

    async init(data) {
        this.splatCount = data.splatCount;
        this.positions = data.positions;
        this.colors = data.colors;
        this.opacities = data.opacities;

        // Split cov3D into A/B
        this.cov3DsA = new Float32Array(this.splatCount * 3);
        this.cov3DsB = new Float32Array(this.splatCount * 3);
        for (let i = 0; i < this.splatCount; i++) {
            this.cov3DsA.set(data.cov3Ds.subarray(i * 6, i * 6 + 3), i * 3);
            this.cov3DsB.set(data.cov3Ds.subarray(i * 6 + 3, i * 6 + 6), i * 3);
        }

        // Geometry
        this.geometry = new THREE.InstancedBufferGeometry();
        this.geometry.setAttribute('position', new THREE.BufferAttribute(
            new Float32Array([-1,-1,0, 1,-1,0, -1,1,0, 1,1,0]), 3));
        this.geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0,1,2,2,1,3]), 1));

        const n = this.splatCount;
        this.geometry.setAttribute('a_center', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
        this.geometry.setAttribute('a_col', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
        this.geometry.setAttribute('a_opacity', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
        this.geometry.setAttribute('a_covA', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
        this.geometry.setAttribute('a_covB', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
        this.geometry.instanceCount = n;

        // Material
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                W: { value: innerWidth }, H: { value: innerHeight },
                focal_x: { value: 0 }, focal_y: { value: 0 },
                tan_fovx: { value: 0 }, tan_fovy: { value: 0 },
                viewmatrix: { value: new THREE.Matrix4() },
                projmatrix: { value: new THREE.Matrix4() }
            },
            vertexShader, fragmentShader,
            transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
        });

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.frustumCulled = false;

        // Worker
        this.worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
        this.worker.onmessage = e => {
            this.sortedIndices = e.data.indices;
            this.isWorkerSorting = false;
            this.applySort();
        };
        this.worker.postMessage({ type: 'init', data: { positions: this.positions.buffer.slice(0), splatCount: n }});

        this.updateBuffers();
    }

    updateBuffers() {
        const g = this.geometry;
        g.getAttribute('a_center').array.set(this.positions);
        g.getAttribute('a_col').array.set(this.colors);
        g.getAttribute('a_opacity').array.set(this.opacities);
        g.getAttribute('a_covA').array.set(this.cov3DsA);
        g.getAttribute('a_covB').array.set(this.cov3DsB);
        for (const name of ['a_center', 'a_col', 'a_opacity', 'a_covA', 'a_covB'])
            g.getAttribute(name).needsUpdate = true;
    }

    applySort() {
        if (!this.sortedIndices) return;
        const g = this.geometry;
        const [c, col, op, cA, cB] = ['a_center', 'a_col', 'a_opacity', 'a_covA', 'a_covB'].map(n => g.getAttribute(n));

        for (let i = 0; i < this.splatCount; i++) {
            const s = this.sortedIndices[i];
            c.array.set(this.positions.subarray(s * 3, s * 3 + 3), i * 3);
            col.array.set(this.colors.subarray(s * 3, s * 3 + 3), i * 3);
            op.array[i] = this.opacities[s];
            cA.array.set(this.cov3DsA.subarray(s * 3, s * 3 + 3), i * 3);
            cB.array.set(this.cov3DsB.subarray(s * 3, s * 3 + 3), i * 3);
        }
        c.needsUpdate = col.needsUpdate = op.needsUpdate = cA.needsUpdate = cB.needsUpdate = true;
    }

    update(camera) {
        if (!this.mesh) return;
        const W = innerWidth, H = innerHeight;
        const fov_y = camera.fov * Math.PI / 180;
        const tan_fovy = Math.tan(fov_y * 0.5);
        const tan_fovx = tan_fovy * W / H;
        const u = this.material.uniforms;
        u.W.value = W; u.H.value = H;
        u.focal_x.value = W / (2 * tan_fovx);
        u.focal_y.value = H / (2 * tan_fovy);
        u.tan_fovx.value = tan_fovx;
        u.tan_fovy.value = tan_fovy;

        camera.updateMatrixWorld();
        const vm = camera.matrixWorldInverse;
        u.viewmatrix.value.copy(vm);
        u.projmatrix.value.multiplyMatrices(camera.projectionMatrix, vm);

        if (!this.isWorkerSorting) {
            let diff = 0;
            for (let i = 0; i < 16; i++)
                diff += Math.abs(camera.matrixWorld.elements[i] - this.lastCameraMatrix.elements[i]);
            if (diff > 0.01) {
                this.lastCameraMatrix.copy(camera.matrixWorld);
                this.isWorkerSorting = true;
                this.worker.postMessage({ type: 'sort', data: { viewMatrix: Array.from(vm.elements) }});
            }
        }
    }

    resize(w, h) {
        if (this.material) { this.material.uniforms.W.value = w; this.material.uniforms.H.value = h; }
    }

    dispose() {
        this.worker?.terminate();
        this.geometry?.dispose();
        this.material?.dispose();
    }
}
