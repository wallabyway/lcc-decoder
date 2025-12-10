/**
 * Gaussian Splat Renderer for Three.js
 * Adapted from kishimisu/Gaussian-Splatting-WebGL
 * Data Organization Format originated from XGRIDS
 */

import * as THREE from 'three';

// Vertex shader adapted for Three.js
const vertexShader = `
precision highp float;

// Per-splat attributes (instanced)
attribute vec3 a_center;
attribute vec3 a_col;
attribute float a_opacity;
attribute vec3 a_covA;
attribute vec3 a_covB;

// Uniforms
uniform float W;
uniform float H;
uniform float focal_x;
uniform float focal_y;
uniform float tan_fovx;
uniform float tan_fovy;
uniform float scale_modifier;
uniform mat4 viewmatrix;
uniform mat4 projmatrix;

// Outputs to fragment shader
varying vec3 v_col;
varying float v_depth;
varying float v_scale_modif;
varying vec4 v_con_o;
varying vec2 v_xy;
varying vec2 v_pixf;

vec3 computeCov2D(vec3 mean, float focal_x, float focal_y, float tan_fovx, float tan_fovy, float cov3D[6], mat4 viewmatrix) {
    vec4 t = viewmatrix * vec4(mean, 1.0);

    float limx = 1.3 * tan_fovx;
    float limy = 1.3 * tan_fovy;
    float txtz = t.x / t.z;
    float tytz = t.y / t.z;
    t.x = min(limx, max(-limx, txtz)) * t.z;
    t.y = min(limy, max(-limy, tytz)) * t.z;

    mat3 J = mat3(
        focal_x / t.z, 0.0, -(focal_x * t.x) / (t.z * t.z),
        0.0, focal_y / t.z, -(focal_y * t.y) / (t.z * t.z),
        0.0, 0.0, 0.0
    );

    mat3 W = mat3(
        viewmatrix[0][0], viewmatrix[1][0], viewmatrix[2][0],
        viewmatrix[0][1], viewmatrix[1][1], viewmatrix[2][1],
        viewmatrix[0][2], viewmatrix[1][2], viewmatrix[2][2]
    );

    mat3 T = W * J;

    mat3 Vrk = mat3(
        cov3D[0], cov3D[1], cov3D[2],
        cov3D[1], cov3D[3], cov3D[4],
        cov3D[2], cov3D[4], cov3D[5]
    );

    mat3 cov = transpose(T) * transpose(Vrk) * T;

    cov[0][0] += 0.3;
    cov[1][1] += 0.3;
    return vec3(cov[0][0], cov[0][1], cov[1][1]);
}

float ndc2Pix(float v, float S) {
    return ((v + 1.0) * S - 1.0) * 0.5;
}

void main() {
    vec3 p_orig = a_center;

    // Transform point by projecting
    vec4 p_hom = projmatrix * vec4(p_orig, 1.0);
    float p_w = 1.0 / (p_hom.w + 1e-7);
    vec3 p_proj = p_hom.xyz * p_w;

    // Perform near culling
    vec4 p_view = viewmatrix * vec4(p_orig, 1.0);
    if (p_view.z > -0.2) {
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Build covariance array
    float cov3D[6];
    cov3D[0] = a_covA.x;
    cov3D[1] = a_covA.y;
    cov3D[2] = a_covA.z;
    cov3D[3] = a_covB.x;
    cov3D[4] = a_covB.y;
    cov3D[5] = a_covB.z;

    // Compute 2D screen-space covariance matrix
    vec3 cov = computeCov2D(p_orig, focal_x, focal_y, tan_fovx, tan_fovy, cov3D, viewmatrix);

    // Invert covariance (EWA algorithm)
    float det = (cov.x * cov.z - cov.y * cov.y);
    if (det == 0.0) {
        gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    float det_inv = 1.0 / det;
    vec3 conic = vec3(cov.z, -cov.y, cov.x) * det_inv;

    // Compute extent in screen space
    float mid = 0.5 * (cov.x + cov.z);
    float lambda1 = mid + sqrt(max(0.1, mid * mid - det));
    float lambda2 = mid - sqrt(max(0.1, mid * mid - det));
    float my_radius = ceil(3.0 * sqrt(max(lambda1, lambda2)));
    vec2 point_image = vec2(ndc2Pix(p_proj.x, W), ndc2Pix(p_proj.y, H));

    // Apply scale modifier
    my_radius *= 0.15 + scale_modifier * 0.85;
    v_scale_modif = 1.0 / scale_modifier;

    // Convert vertex ID to corner offset
    // Three.js uses position attribute for quad corners
    vec2 corner = position.xy;
    vec2 screen_pos = point_image + my_radius * corner;

    // Store data for fragment shader
    v_col = a_col;
    v_con_o = vec4(conic, a_opacity);
    v_xy = point_image;
    v_pixf = screen_pos;
    v_depth = -p_view.z;

    // Convert from screen-space to clip-space
    vec2 clip_pos = screen_pos / vec2(W, H) * 2.0 - 1.0;

    gl_Position = vec4(clip_pos, 0.0, 1.0);
}
`;

// Fragment shader
const fragmentShader = `
precision highp float;

uniform bool show_depth_map;

varying vec3 v_col;
varying float v_scale_modif;
varying float v_depth;
varying vec4 v_con_o;
varying vec2 v_xy;
varying vec2 v_pixf;

vec3 depth_palette(float x) { 
    x = min(1.0, x);
    return vec3(sin(x * 6.28 / 4.0), x * x, mix(sin(x * 6.28), x, 0.6));
}

void main() {
    // Resample using conic matrix
    vec2 d = v_xy - v_pixf;
    float power = -0.5 * (v_con_o.x * d.x * d.x + v_con_o.z * d.y * d.y) - v_con_o.y * d.x * d.y;

    if (power > 0.0) {
        discard;
    }

    // Apply scale modifier
    power *= v_scale_modif;

    // Eq. (2) from 3D Gaussian splatting paper
    float alpha = min(0.99, v_con_o.w * exp(power));
    
    // Colorize with depth or color
    vec3 color = v_col;
    if (show_depth_map) {
        color = depth_palette(v_depth * 0.08);
    }

    if (alpha < 1.0 / 255.0) {
        discard;
    }

    // Eq. (3) from 3D Gaussian splatting paper
    gl_FragColor = vec4(color * alpha, alpha);
}
`;

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
        this.needsSort = true;
        
        // Data buffers
        this.positions = null;
        this.colors = null;
        this.opacities = null;
        this.cov3DsA = null;
        this.cov3DsB = null;
        
        // Sorted indices
        this.sortedIndices = null;
    }

    async init(data) {
        this.splatCount = data.splatCount;
        
        // Store original data
        this.positions = data.positions;
        this.colors = data.colors;
        this.opacities = data.opacities;
        
        // Split cov3D into A (first 3) and B (last 3) components
        this.cov3DsA = new Float32Array(this.splatCount * 3);
        this.cov3DsB = new Float32Array(this.splatCount * 3);
        
        for (let i = 0; i < this.splatCount; i++) {
            this.cov3DsA[i * 3 + 0] = data.cov3Ds[i * 6 + 0];
            this.cov3DsA[i * 3 + 1] = data.cov3Ds[i * 6 + 1];
            this.cov3DsA[i * 3 + 2] = data.cov3Ds[i * 6 + 2];
            this.cov3DsB[i * 3 + 0] = data.cov3Ds[i * 6 + 3];
            this.cov3DsB[i * 3 + 1] = data.cov3Ds[i * 6 + 4];
            this.cov3DsB[i * 3 + 2] = data.cov3Ds[i * 6 + 5];
        }

        // Create geometry with instanced quad
        this.geometry = new THREE.InstancedBufferGeometry();
        
        // Base quad (2 triangles)
        const quadPositions = new Float32Array([
            -1, -1, 0,
             1, -1, 0,
            -1,  1, 0,
             1,  1, 0
        ]);
        const quadIndices = new Uint16Array([0, 1, 2, 2, 1, 3]);
        
        this.geometry.setAttribute('position', new THREE.BufferAttribute(quadPositions, 3));
        this.geometry.setIndex(new THREE.BufferAttribute(quadIndices, 1));

        // Instance attributes
        this.geometry.setAttribute('a_center', new THREE.InstancedBufferAttribute(
            new Float32Array(this.splatCount * 3), 3
        ));
        this.geometry.setAttribute('a_col', new THREE.InstancedBufferAttribute(
            new Float32Array(this.splatCount * 3), 3
        ));
        this.geometry.setAttribute('a_opacity', new THREE.InstancedBufferAttribute(
            new Float32Array(this.splatCount), 1
        ));
        this.geometry.setAttribute('a_covA', new THREE.InstancedBufferAttribute(
            new Float32Array(this.splatCount * 3), 3
        ));
        this.geometry.setAttribute('a_covB', new THREE.InstancedBufferAttribute(
            new Float32Array(this.splatCount * 3), 3
        ));

        // Set instance count - CRITICAL for instanced rendering
        this.geometry.instanceCount = this.splatCount;

        // Create material
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                W: { value: window.innerWidth },
                H: { value: window.innerHeight },
                focal_x: { value: 0 },
                focal_y: { value: 0 },
                tan_fovx: { value: 0 },
                tan_fovy: { value: 0 },
                scale_modifier: { value: 1.0 }, // Default scale
                viewmatrix: { value: new THREE.Matrix4() },
                projmatrix: { value: new THREE.Matrix4() },
                show_depth_map: { value: false }
            },
            vertexShader,
            fragmentShader,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor
        });

        // Create mesh
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.frustumCulled = false;

        // Initialize sort worker
        this.initWorker();

        // Initial sort
        this.updateBuffers();
    }

    initWorker() {
        // Create inline worker for sorting
        const workerCode = `
            let positions = null;
            let splatCount = 0;

            self.onmessage = function(e) {
                const { type, data } = e.data;
                
                if (type === 'init') {
                    positions = new Float32Array(data.positions);
                    splatCount = data.splatCount;
                    return;
                }
                
                if (type === 'sort') {
                    const viewMatrix = data.viewMatrix;
                    const start = performance.now();
                    
                    // Calculate depth for each splat
                    const depths = new Float32Array(splatCount);
                    for (let i = 0; i < splatCount; i++) {
                        const x = positions[i * 3 + 0];
                        const y = positions[i * 3 + 1];
                        const z = positions[i * 3 + 2];
                        // Transform to view space and get Z depth (Three.js: negative Z is forward)
                        depths[i] = viewMatrix[2] * x + viewMatrix[6] * y + viewMatrix[10] * z + viewMatrix[14];
                    }
                    
                    // Create index array
                    const indices = new Uint32Array(splatCount);
                    for (let i = 0; i < splatCount; i++) {
                        indices[i] = i;
                    }
                    
                    // Sort by depth (back to front - most negative first in Three.js)
                    indices.sort((a, b) => depths[a] - depths[b]);
                    
                    const sortTime = performance.now() - start;
                    
                    self.postMessage({
                        indices: indices,
                        sortTime: sortTime
                    }, [indices.buffer]);
                }
            };
        `;
        
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
        
        this.worker.onmessage = (e) => {
            const { indices, sortTime } = e.data;
            this.sortTime = sortTime;
            this.sortedIndices = indices;
            this.isWorkerSorting = false;
            this.applySort();
        };
        
        // Initialize worker with position data
        this.worker.postMessage({
            type: 'init',
            data: {
                positions: this.positions.buffer.slice(0),
                splatCount: this.splatCount
            }
        });
    }

    updateBuffers() {
        // Copy data to geometry buffers in original order initially
        const centerAttr = this.geometry.getAttribute('a_center');
        const colorAttr = this.geometry.getAttribute('a_col');
        const opacityAttr = this.geometry.getAttribute('a_opacity');
        const covAAttr = this.geometry.getAttribute('a_covA');
        const covBAttr = this.geometry.getAttribute('a_covB');

        centerAttr.array.set(this.positions);
        colorAttr.array.set(this.colors);
        opacityAttr.array.set(this.opacities);
        covAAttr.array.set(this.cov3DsA);
        covBAttr.array.set(this.cov3DsB);

        centerAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        opacityAttr.needsUpdate = true;
        covAAttr.needsUpdate = true;
        covBAttr.needsUpdate = true;
    }

    applySort() {
        if (!this.sortedIndices) return;
        
        const centerAttr = this.geometry.getAttribute('a_center');
        const colorAttr = this.geometry.getAttribute('a_col');
        const opacityAttr = this.geometry.getAttribute('a_opacity');
        const covAAttr = this.geometry.getAttribute('a_covA');
        const covBAttr = this.geometry.getAttribute('a_covB');

        // Reorder all attributes based on sorted indices
        for (let i = 0; i < this.splatCount; i++) {
            const srcIdx = this.sortedIndices[i];
            
            centerAttr.array[i * 3 + 0] = this.positions[srcIdx * 3 + 0];
            centerAttr.array[i * 3 + 1] = this.positions[srcIdx * 3 + 1];
            centerAttr.array[i * 3 + 2] = this.positions[srcIdx * 3 + 2];
            
            colorAttr.array[i * 3 + 0] = this.colors[srcIdx * 3 + 0];
            colorAttr.array[i * 3 + 1] = this.colors[srcIdx * 3 + 1];
            colorAttr.array[i * 3 + 2] = this.colors[srcIdx * 3 + 2];
            
            opacityAttr.array[i] = this.opacities[srcIdx];
            
            covAAttr.array[i * 3 + 0] = this.cov3DsA[srcIdx * 3 + 0];
            covAAttr.array[i * 3 + 1] = this.cov3DsA[srcIdx * 3 + 1];
            covAAttr.array[i * 3 + 2] = this.cov3DsA[srcIdx * 3 + 2];
            
            covBAttr.array[i * 3 + 0] = this.cov3DsB[srcIdx * 3 + 0];
            covBAttr.array[i * 3 + 1] = this.cov3DsB[srcIdx * 3 + 1];
            covBAttr.array[i * 3 + 2] = this.cov3DsB[srcIdx * 3 + 2];
        }

        centerAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        opacityAttr.needsUpdate = true;
        covAAttr.needsUpdate = true;
        covBAttr.needsUpdate = true;
    }

    update(camera) {
        if (!this.mesh) return;

        // Update uniforms
        const W = window.innerWidth;
        const H = window.innerHeight;
        const fov_y = camera.fov * Math.PI / 180;
        const tan_fovy = Math.tan(fov_y * 0.5);
        const tan_fovx = tan_fovy * W / H;
        const focal_y = H / (2 * tan_fovy);
        const focal_x = W / (2 * tan_fovx);

        this.material.uniforms.W.value = W;
        this.material.uniforms.H.value = H;
        this.material.uniforms.focal_x.value = focal_x;
        this.material.uniforms.focal_y.value = focal_y;
        this.material.uniforms.tan_fovx.value = tan_fovx;
        this.material.uniforms.tan_fovy.value = tan_fovy;
        
        // Get view and projection matrices
        camera.updateMatrixWorld();
        const viewMatrix = camera.matrixWorldInverse;
        const projMatrix = camera.projectionMatrix;
        
        // Combined view-projection matrix
        const vpm = new THREE.Matrix4();
        vpm.multiplyMatrices(projMatrix, viewMatrix);
        
        this.material.uniforms.viewmatrix.value.copy(viewMatrix);
        this.material.uniforms.projmatrix.value.copy(vpm);

        // Check if camera moved significantly - trigger resort
        if (!this.isWorkerSorting) {
            const currentMatrix = camera.matrixWorld;
            let diff = 0;
            for (let i = 0; i < 16; i++) {
                diff += Math.abs(currentMatrix.elements[i] - this.lastCameraMatrix.elements[i]);
            }
            
            if (diff > 0.01) {
                this.lastCameraMatrix.copy(currentMatrix);
                this.requestSort(viewMatrix);
            }
        }
    }

    requestSort(viewMatrix) {
        if (this.isWorkerSorting || !this.worker) return;
        
        this.isWorkerSorting = true;
        this.worker.postMessage({
            type: 'sort',
            data: {
                viewMatrix: Array.from(viewMatrix.elements)
            }
        });
    }

    resize(width, height) {
        if (this.material) {
            this.material.uniforms.W.value = width;
            this.material.uniforms.H.value = height;
        }
    }

    dispose() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        if (this.geometry) {
            this.geometry.dispose();
        }
        if (this.material) {
            this.material.dispose();
        }
    }
}

