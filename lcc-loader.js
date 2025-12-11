/**
 * LCC (Lixel CyberColor) Format Loader
 * Decodes LCC format for 3D Gaussian Splatting
 * Data Organization Format originated from XGRIDS
 */

const BYTES_PER_SPLAT = 32;
const QLUT = [3, 0, 1, 2, 0, 3, 1, 2, 0, 1, 3, 2, 0, 1, 2, 3];
const SQRT2 = 1.414213562373095;
const RSQRT2 = 0.7071067811865475;

export class LCCLoader {
    constructor(options = {}) {
        this.meta = null;
        this.attributes = {};
        this.targetLOD = options.targetLOD ?? 4;
    }

    async load(basePath, onProgress = () => {}) {
        // Resolve paths
        const isLccFile = basePath.endsWith('.lcc');
        const metaUrl = isLccFile ? basePath : `${basePath.replace(/\/?$/, '/')}/meta.lcc`;
        this.dataBasePath = isLccFile ? basePath.substring(0, basePath.lastIndexOf('/') + 1) : basePath.replace(/\/?$/, '/');

        // Load metadata
        onProgress(0.05);
        const metaResponse = await fetch(metaUrl, { mode: 'cors' });
        this.meta = await metaResponse.json();
        this.parseAttributes();

        // Calculate LOD byte range
        const splatCounts = this.meta.splats;
        let dataOffset = 0;
        for (let i = 0; i < this.targetLOD; i++) {
            dataOffset += splatCounts[i] * BYTES_PER_SPLAT;
        }
        const totalSplats = splatCounts[this.targetLOD];
        const dataSize = totalSplats * BYTES_PER_SPLAT;

        // Load splat data with range request
        onProgress(0.2);
        const dataUrl = `${this.dataBasePath}data.bin`;
        let dataResponse = await fetch(dataUrl, {
            mode: 'cors',
            headers: { 'Range': `bytes=${dataOffset}-${dataOffset + dataSize - 1}` }
        });

        let dataBuffer;
        if (dataResponse.status === 206) {
            dataBuffer = await dataResponse.arrayBuffer();
        } else {
            const fullBuffer = await (await fetch(dataUrl, { mode: 'cors' })).arrayBuffer();
            dataBuffer = fullBuffer.slice(dataOffset, dataOffset + dataSize);
        }

        // Parse splat data
        onProgress(0.5);
        const splatData = this.parseSplats(new DataView(dataBuffer), totalSplats, onProgress);

        // Load spherical harmonics if Quality mode
        let shData = null;
        if (this.meta.fileType === 'Quality') {
            try {
                const shResponse = await fetch(`${this.dataBasePath}shcoef.bin`, { mode: 'cors' });
                if (shResponse.ok) shData = this.parseShcoef(await shResponse.arrayBuffer());
            } catch (e) {}
        }

        onProgress(1.0);
        return {
            meta: this.meta,
            splatCount: totalSplats,
            totalSplats: this.meta.totalSplats,
            boundingBox: this.meta.boundingBox,
            ...splatData,
            sphericalHarmonics: shData
        };
    }

    parseAttributes() {
        if (!this.meta.attributes) return;
        for (const attr of this.meta.attributes) {
            this.attributes[attr.name] = { min: attr.min, max: attr.max };
        }
    }

    parseSplats(view, count, onProgress) {
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const opacities = new Float32Array(count);
        const scales = new Float32Array(count * 3);
        const rotations = new Float32Array(count * 4);
        const cov3Ds = new Float32Array(count * 6);

        const scaleAttr = this.attributes.scale || { min: [-10, -10, -10], max: [10, 10, 10] };

        for (let i = 0; i < count; i++) {
            const o = i * BYTES_PER_SPLAT;

            // Position (12 bytes)
            positions[i * 3] = view.getFloat32(o, true);
            positions[i * 3 + 1] = view.getFloat32(o + 4, true);
            positions[i * 3 + 2] = view.getFloat32(o + 8, true);

            // Color + Opacity (4 bytes)
            const colorEnc = view.getUint32(o + 12, true);
            colors[i * 3] = (colorEnc & 0xFF) / 255;
            colors[i * 3 + 1] = ((colorEnc >> 8) & 0xFF) / 255;
            colors[i * 3 + 2] = ((colorEnc >> 16) & 0xFF) / 255;
            opacities[i] = ((colorEnc >> 24) & 0xFF) / 255;

            // Scale (6 bytes) - Uint16 normalized then lerped
            const sx = view.getUint16(o + 16, true) / 65535;
            const sy = view.getUint16(o + 18, true) / 65535;
            const sz = view.getUint16(o + 20, true) / 65535;
            scales[i * 3] = scaleAttr.min[0] + (scaleAttr.max[0] - scaleAttr.min[0]) * sx;
            scales[i * 3 + 1] = scaleAttr.min[1] + (scaleAttr.max[1] - scaleAttr.min[1]) * sy;
            scales[i * 3 + 2] = scaleAttr.min[2] + (scaleAttr.max[2] - scaleAttr.min[2]) * sz;

            // Rotation (4 bytes) - compressed quaternion
            const q = this.decodeRotation(view.getUint32(o + 22, true));
            rotations[i * 4] = q[0];
            rotations[i * 4 + 1] = q[1];
            rotations[i * 4 + 2] = q[2];
            rotations[i * 4 + 3] = -q[3];

            // Compute covariance
            const cov = this.computeCov3D(
                [scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2]],
                [rotations[i * 4], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]]
            );
            cov3Ds.set(cov, i * 6);

            if (i % 50000 === 0) onProgress(0.5 + 0.4 * (i / count));
        }

        return { positions, colors, opacities, scales, rotations, cov3Ds };
    }

    decodeRotation(enc) {
        // Unpack 10+10+10+2 bits
        const pq0 = (enc & 1023) / 1023;
        const pq1 = ((enc >> 10) & 1023) / 1023;
        const pq2 = ((enc >> 20) & 1023) / 1023;
        const idx = (enc >> 30) & 3;

        // Decode components
        const q0 = pq0 * SQRT2 - RSQRT2;
        const q1 = pq1 * SQRT2 - RSQRT2;
        const q2 = pq2 * SQRT2 - RSQRT2;
        const q3 = Math.sqrt(Math.max(0, 1 - q0*q0 - q1*q1 - q2*q2));

        // Reorder via lookup table
        const q = [q0, q1, q2, q3];
        const p = [q[QLUT[idx * 4]], q[QLUT[idx * 4 + 1]], q[QLUT[idx * 4 + 2]], q[QLUT[idx * 4 + 3]]];

        // Normalize
        const len = Math.sqrt(p[0]*p[0] + p[1]*p[1] + p[2]*p[2] + p[3]*p[3]);
        return len > 0 ? [p[0]/len, p[1]/len, p[2]/len, p[3]/len] : p;
    }

    computeCov3D(scale, rot) {
        const [x, y, z, w] = rot;

        // Rotation matrix from quaternion (x,y,z,w)
        const R = [
            1 - 2*(y*y + z*z), 2*(x*y - w*z), 2*(x*z + w*y),
            2*(x*y + w*z), 1 - 2*(x*x + z*z), 2*(y*z - w*x),
            2*(x*z - w*y), 2*(y*z + w*x), 1 - 2*(x*x + y*y)
        ];

        // M = S * R
        const M = [
            scale[0]*R[0], scale[0]*R[1], scale[0]*R[2],
            scale[1]*R[3], scale[1]*R[4], scale[1]*R[5],
            scale[2]*R[6], scale[2]*R[7], scale[2]*R[8]
        ];

        // Sigma = M^T * M (return upper triangle)
        return [
            M[0]*M[0] + M[3]*M[3] + M[6]*M[6],
            M[0]*M[1] + M[3]*M[4] + M[6]*M[7],
            M[0]*M[2] + M[3]*M[5] + M[6]*M[8],
            M[1]*M[1] + M[4]*M[4] + M[7]*M[7],
            M[1]*M[2] + M[4]*M[5] + M[7]*M[8],
            M[2]*M[2] + M[5]*M[5] + M[8]*M[8]
        ];
    }

    parseShcoef(buffer) {
        const BYTES_PER_SH = 64;
        const count = Math.floor(buffer.byteLength / BYTES_PER_SH);
        const view = new DataView(buffer);
        const shCoeffs = new Float32Array(count * 45);
        const attr = this.attributes.shcoef || { min: [-1, -1, -1], max: [1, 1, 1] };

        for (let i = 0; i < count; i++) {
            const o = i * BYTES_PER_SH;
            for (let j = 0; j < 15; j++) {
                const enc = view.getUint32(o + j * 4, true);
                const d0 = (enc & 2047) / 2047;
                const d1 = ((enc >> 11) & 1023) / 1023;
                const d2 = ((enc >> 21) & 2047) / 2047;
                shCoeffs[i * 45 + j * 3] = attr.min[0] + (attr.max[0] - attr.min[0]) * d0;
                shCoeffs[i * 45 + j * 3 + 1] = attr.min[1] + (attr.max[1] - attr.min[1]) * d1;
                shCoeffs[i * 45 + j * 3 + 2] = attr.min[2] + (attr.max[2] - attr.min[2]) * d2;
            }
        }
        return shCoeffs;
    }
}
