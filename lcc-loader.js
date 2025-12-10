/**
 * LCC (Lixel CyberColor) Format Loader
 * Data Organization Format originated from XGRIDS
 * 
 * Decodes LCC format for 3D Gaussian Splatting
 */

export class LCCLoader {
    constructor(options = {}) {
        this.meta = null;
        this.attributes = {};
        // LOD level to load (0 = highest detail, higher = lower detail)
        this.targetLOD = options.targetLOD !== undefined ? options.targetLOD : 4; // Default to level 4 (~1.5M splats)
    }

    /**
     * Load LCC data from a base path
     * @param {string} basePath - Path to the LCC data folder or .lcc file
     * @param {Function} onProgress - Progress callback (0-1)
     * @returns {Promise<Object>} Decoded splat data
     */
    async load(basePath, onProgress = () => {}) {
        let metaUrl = '';
        let dataBasePath = '';
        
        // Determine if basePath is a .lcc file or a directory
        if (basePath.endsWith('.lcc')) {
            // The .lcc file IS the meta file (e.g., showroom2.lcc)
            metaUrl = basePath;
            // Data files are in the SAME directory as the .lcc file
            const lastSlash = basePath.lastIndexOf('/');
            dataBasePath = basePath.substring(0, lastSlash + 1);
            
            console.log('LCC file mode:', { metaUrl, dataBasePath });
        } else {
            // Traditional directory structure with meta.lcc inside
            if (!basePath.endsWith('/')) {
                basePath += '/';
            }
            metaUrl = basePath + 'meta.lcc';
            dataBasePath = basePath;
            
            console.log('Directory mode:', { metaUrl, dataBasePath });
        }

        // Step 1: Load meta file (JSON)
        onProgress(0.05);
        const metaResponse = await fetch(metaUrl);
        if (!metaResponse.ok) {
            throw new Error(`Failed to load meta file: ${metaResponse.status}`);
        }
        this.meta = await metaResponse.json();
        console.log('LCC Meta:', this.meta);
        
        // Store the data base path for subsequent file loads
        this.dataBasePath = dataBasePath;

        // Parse attributes for min/max interpolation
        this.parseAttributes();

        // Step 2: Load index.bin (lowercase)
        onProgress(0.1);
        const indexResponse = await fetch(this.dataBasePath + 'index.bin');
        if (!indexResponse.ok) {
            throw new Error(`Failed to load index.bin: ${indexResponse.status}`);
        }
        const indexBuffer = await indexResponse.arrayBuffer();
        const indexData = this.parseIndex(indexBuffer);
        
        // Step 3: Determine LOD data range
        // For "Portable" format, LOD data is stored sequentially in Data.bin
        // Calculate offset and size based on meta.splats array
        const splatCounts = this.meta.splats; // Array of splat counts per LOD level
        
        if (this.targetLOD >= splatCounts.length) {
            throw new Error(`LOD level ${this.targetLOD} not available. Max level is ${splatCounts.length - 1}`);
        }
        
        // Calculate byte offset for target LOD
        // Data is stored as: [LOD0][LOD1][LOD2]...[LOD6]
        const BYTES_PER_SPLAT = 32;
        let dataOffset = 0;
        for (let i = 0; i < this.targetLOD; i++) {
            dataOffset += splatCounts[i] * BYTES_PER_SPLAT;
        }
        
        const totalSplatsInLOD = splatCounts[this.targetLOD];
        const dataSize = totalSplatsInLOD * BYTES_PER_SPLAT;
        
        console.log(`Loading LOD ${this.targetLOD}: ${totalSplatsInLOD.toLocaleString()} splats`);
        console.log(`Byte range: ${dataOffset} - ${dataOffset + dataSize} (${(dataSize / 1024 / 1024).toFixed(1)} MB)`);
        console.log('Available LOD levels:', splatCounts.map((count, idx) => `L${idx}: ${(count/1000000).toFixed(2)}M`).join(', '));
        
        // Create a single "unit" for the LOD data
        const lodUnits = [{
            level: this.targetLOD,
            dataOffset,
            dataSize,
            splatCount: totalSplatsInLOD
        }];
        
        // Step 4: Load data for target LOD level
        const firstOffset = dataOffset;
        const lastOffset = dataOffset + dataSize;
        
        onProgress(0.2);
        
        // Load the specific LOD range from data.bin (lowercase)
        const dataUrl = this.dataBasePath + 'data.bin';
        console.log(`Requesting from: ${dataUrl}`);
        console.log(`Range: bytes=${firstOffset}-${lastOffset - 1} (size: ${dataSize} bytes)`);
        
        let dataResponse = await fetch(dataUrl, {
            headers: { 'Range': `bytes=${firstOffset}-${lastOffset - 1}` }
        });
        
        console.log(`Response status: ${dataResponse.status}, Content-Length: ${dataResponse.headers.get('Content-Length')}`);
        
        // Handle range request failures (416 = Range Not Satisfiable)
        let dataBuffer;
        if (dataResponse.status === 416 || (!dataResponse.ok && dataResponse.status !== 206)) {
            console.warn(`Range request failed (${dataResponse.status}), fetching entire file...`);
            dataResponse = await fetch(dataUrl);
            if (!dataResponse.ok) {
                throw new Error(`Failed to load data.bin: ${dataResponse.status} ${dataResponse.statusText}`);
            }
            const fullBuffer = await dataResponse.arrayBuffer();
            console.log(`Full file loaded: ${fullBuffer.byteLength} bytes, extracting range ${firstOffset}-${lastOffset}`);
            
            if (fullBuffer.byteLength === 0) {
                throw new Error(`data.bin is empty! URL: ${dataUrl}`);
            }
            
            if (lastOffset > fullBuffer.byteLength) {
                throw new Error(`Range ${firstOffset}-${lastOffset} exceeds file size ${fullBuffer.byteLength}`);
            }
            
            dataBuffer = fullBuffer.slice(firstOffset, lastOffset);
        } else {
            dataBuffer = await dataResponse.arrayBuffer();
        }
        
        if (dataBuffer.byteLength === 0) {
            throw new Error(`Received empty buffer! Expected ${dataSize} bytes from ${dataUrl}`);
        }
        
        console.log(`Data buffer loaded: ${dataBuffer.byteLength} bytes (expected: ${dataSize})`);
        
        onProgress(0.5);
        
        // Step 5: Parse splat data from LOD chunks
        const splatData = this.parseDataFromChunks(dataBuffer, lodUnits, firstOffset, onProgress);
        
        // Step 5: Load shcoef.bin if Quality mode (lowercase)
        let shData = null;
        if (this.meta.fileType === 'Quality') {
            onProgress(0.8);
            try {
                const shResponse = await fetch(this.dataBasePath + 'shcoef.bin');
                if (shResponse.ok) {
                    const shBuffer = await shResponse.arrayBuffer();
                    shData = this.parseShcoef(shBuffer);
                }
            } catch (e) {
                console.warn('Shcoef.bin not found or failed to load');
            }
        }

        onProgress(1.0);

        return {
            meta: this.meta,
            splatCount: splatData.splatCount, // Actual loaded count
            totalSplats: this.meta.totalSplats, // Total in file
            boundingBox: this.meta.boundingBox,
            positions: splatData.positions,
            colors: splatData.colors,
            opacities: splatData.opacities,
            scales: splatData.scales,
            rotations: splatData.rotations,
            cov3Ds: splatData.cov3Ds,
            sphericalHarmonics: shData
        };
    }

    /**
     * Parse attributes from meta for min/max interpolation
     */
    parseAttributes() {
        if (!this.meta.attributes) return;
        
        for (const attr of this.meta.attributes) {
            this.attributes[attr.name] = {
                min: attr.min,
                max: attr.max
            };
        }
    }

    /**
     * Parse Index.bin file
     * Each index entry contains LOD level, position, offset, and size
     */
    parseIndex(buffer) {
        const view = new DataView(buffer);
        const indexDataSize = this.meta.indexDataSize;
        const totalUnits = Math.floor(buffer.byteLength / indexDataSize);
        
        const units = [];
        const levelCounts = new Map();
        
        for (let i = 0; i < totalUnits; i++) {
            const offset = i * indexDataSize;
            
            // Parse index structure
            // Try different offset patterns to find the level
            const uint32_0 = view.getUint32(offset, true);
            const uint32_1 = view.getUint32(offset + 4, true);
            
            // Level is typically a small number (0-6), try extracting from different positions
            // Pattern 1: Level in first byte
            let level = uint32_0 & 0xFF;
            
            // Pattern 2: Level might be in bits 24-31
            if (level > 10) {
                level = (uint32_0 >> 24) & 0xFF;
            }
            
            // Pattern 3: Level might be in second uint32
            if (level > 10) {
                level = uint32_1 & 0xFF;
            }
            
            // Data offset - typically uint64 starting at offset 4 or 8
            let dataOffset = Number(view.getBigUint64(offset + 4, true));
            let dataSize = view.getUint32(offset + 12, true);
            
            // Validate and adjust if needed
            if (dataOffset > 2000000000 || dataSize === 0 || dataSize > 10000000) {
                // Try alternate offset positions
                dataOffset = Number(view.getBigUint64(offset + 8, true));
                dataSize = view.getUint32(offset + 16, true);
            }
            
            const splatCount = Math.floor(dataSize / 32);
            
            units.push({
                level,
                dataOffset,
                dataSize,
                splatCount
            });
            
            levelCounts.set(level, (levelCounts.get(level) || 0) + splatCount);
        }
        
        // Log level distribution for debugging
        console.log('Index level distribution:', Array.from(levelCounts.entries()).sort((a,b) => a[0] - b[0]));
        
        return {
            totalUnits,
            units
        };
    }

    /**
     * Parse data from LOD chunks
     */
    parseDataFromChunks(buffer, lodUnits, baseOffset, onProgress) {
        const BYTES_PER_SPLAT = 32;
        const totalSplats = lodUnits.reduce((sum, unit) => sum + unit.splatCount, 0);
        
        console.log(`Parsing ${totalSplats} splats from ${lodUnits.length} chunks`);
        console.log(`Buffer size: ${buffer.byteLength} bytes, base offset: ${baseOffset}`);
        
        const view = new DataView(buffer);
        
        // Output arrays
        const positions = new Float32Array(totalSplats * 3);
        const colors = new Float32Array(totalSplats * 3);
        const opacities = new Float32Array(totalSplats);
        const scales = new Float32Array(totalSplats * 3);
        const rotations = new Float32Array(totalSplats * 4);
        const cov3Ds = new Float32Array(totalSplats * 6);
        
        // Get scale min/max for interpolation
        const scaleAttr = this.attributes.scale || { 
            min: [-10, -10, -10], 
            max: [10, 10, 10] 
        };
        
        let globalIndex = 0;
        
        // Process each chunk
        for (const unit of lodUnits) {
            const chunkOffsetInBuffer = unit.dataOffset - baseOffset;
            const chunkSplatCount = unit.splatCount;
            
            console.log(`Processing chunk: dataOffset=${unit.dataOffset}, offsetInBuffer=${chunkOffsetInBuffer}, splats=${chunkSplatCount}`);
            
            // Validate offset is within buffer bounds
            if (chunkOffsetInBuffer < 0 || chunkOffsetInBuffer >= buffer.byteLength) {
                throw new Error(`Invalid chunk offset: ${chunkOffsetInBuffer} (buffer size: ${buffer.byteLength})`);
            }
            
            for (let i = 0; i < chunkSplatCount; i++) {
                const offset = chunkOffsetInBuffer + (i * BYTES_PER_SPLAT);
                const outIdx = globalIndex + i;
                
                // Validate offset before parsing
                if (offset + BYTES_PER_SPLAT > buffer.byteLength) {
                    throw new Error(`Offset ${offset} + ${BYTES_PER_SPLAT} exceeds buffer size ${buffer.byteLength} at splat ${i}/${chunkSplatCount}`);
                }
                
                // Parse single splat (same logic as original parseData)
                this.parseSingleSplat(view, offset, outIdx, positions, colors, opacities, scales, rotations, cov3Ds, scaleAttr);
            }
            
            globalIndex += chunkSplatCount;
            
            // Progress update
            onProgress(0.5 + 0.3 * (globalIndex / totalSplats));
        }
        
        return {
            splatCount: totalSplats,
            positions,
            colors,
            opacities,
            scales,
            rotations,
            cov3Ds
        };
    }

    /**
     * Parse a single splat from buffer
     */
    parseSingleSplat(view, offset, outIdx, positions, colors, opacities, scales, rotations, cov3Ds, scaleAttr) {
        // Position: bytes 0-11 (3x float32)
        // Rotate -90° around X: Z-up → Y-up (LCC to Three.js coordinate system)
        positions[outIdx * 3 + 0] = view.getFloat32(offset + 0, true);   // X stays X
        positions[outIdx * 3 + 1] = view.getFloat32(offset + 8, true);   // Z becomes Y
        positions[outIdx * 3 + 2] = -view.getFloat32(offset + 4, true);  // Y becomes -Z
        
        // Color: bytes 12-15 (uint32 RGBA - little endian)
        const colorEnc = view.getUint32(offset + 12, true);
        colors[outIdx * 3 + 0] = (colorEnc & 0xFF) / 255;         // R
        colors[outIdx * 3 + 1] = ((colorEnc >> 8) & 0xFF) / 255;  // G  
        colors[outIdx * 3 + 2] = ((colorEnc >> 16) & 0xFF) / 255; // B
        
        // Opacity from alpha channel
        opacities[outIdx] = ((colorEnc >> 24) & 0xFF) / 255;
        
        // Scale: bytes 16-21 (6 bytes = 3x uint16)
        const scaleX = view.getUint16(offset + 16, true) / 65535;
        const scaleY = view.getUint16(offset + 18, true) / 65535;
        const scaleZ = view.getUint16(offset + 20, true) / 65535;
        
        // Interpolate scale using min/max from meta.lcc
        scales[outIdx * 3 + 0] = this.lerp(scaleAttr.min[0], scaleAttr.max[0], scaleX);
        scales[outIdx * 3 + 1] = this.lerp(scaleAttr.min[1], scaleAttr.max[1], scaleY);
        scales[outIdx * 3 + 2] = this.lerp(scaleAttr.min[2], scaleAttr.max[2], scaleZ);
        
        // Rotation: bytes 22-25 (uint32 compressed quaternion)
        const rotEnc = view.getUint32(offset + 22, true);
        const quat = this.decodeRotation(rotEnc);
        
        rotations[outIdx * 4 + 0] = quat[0];
        rotations[outIdx * 4 + 1] = quat[1];
        rotations[outIdx * 4 + 2] = quat[2];
        rotations[outIdx * 4 + 3] = quat[3];
        
        // Compute 3D covariance matrix from scale and rotation
        const cov = this.computeCov3D(
            [scales[outIdx * 3 + 0], scales[outIdx * 3 + 1], scales[outIdx * 3 + 2]],
            [rotations[outIdx * 4 + 0], rotations[outIdx * 4 + 1], rotations[outIdx * 4 + 2], rotations[outIdx * 4 + 3]]
        );
        
        cov3Ds[outIdx * 6 + 0] = cov[0];
        cov3Ds[outIdx * 6 + 1] = cov[1];
        cov3Ds[outIdx * 6 + 2] = cov[2];
        cov3Ds[outIdx * 6 + 3] = cov[3];
        cov3Ds[outIdx * 6 + 4] = cov[4];
        cov3Ds[outIdx * 6 + 5] = cov[5];
    }

    /**
     * Parse Data.bin - 32 bytes per splat
     * Layout (based on spec analysis):
     * - Position: 12 bytes (3x float32)
     * - Scale: 6 bytes (compressed)
     * - Rotation: 4 bytes (uint32 compressed quaternion)
     * - Color: 4 bytes (uint32 RGBA)
     * - Normal/Other: 6 bytes
     */
    parseData(buffer, onProgress, maxSplats = Infinity) {
        const BYTES_PER_SPLAT = 32;
        const splatCount = Math.min(Math.floor(buffer.byteLength / BYTES_PER_SPLAT), maxSplats);
        
        console.log(`Parsing ${splatCount} splats from ${buffer.byteLength} bytes`);
        
        const view = new DataView(buffer);
        
        // Output arrays
        const positions = new Float32Array(splatCount * 3);
        const colors = new Float32Array(splatCount * 3);
        const opacities = new Float32Array(splatCount);
        const scales = new Float32Array(splatCount * 3);
        const rotations = new Float32Array(splatCount * 4);
        
        // Pre-computed covariance matrices (like MVP does)
        const cov3Ds = new Float32Array(splatCount * 6);
        
        // Get scale min/max for interpolation
        const scaleAttr = this.attributes.scale || { 
            min: [-10, -10, -10], 
            max: [10, 10, 10] 
        };
        
        for (let i = 0; i < splatCount; i++) {
            const offset = i * BYTES_PER_SPLAT;
            
            // Position: bytes 0-11 (3x float32)
            // Rotate -90° around X: Z-up → Y-up (LCC to Three.js coordinate system)
            positions[i * 3 + 0] = view.getFloat32(offset + 0, true);   // X stays X
            positions[i * 3 + 1] = view.getFloat32(offset + 8, true);   // Z becomes Y
            positions[i * 3 + 2] = -view.getFloat32(offset + 4, true);  // Y becomes -Z
            
            // Color: bytes 12-15 (uint32 RGBA - little endian)
            const colorEnc = view.getUint32(offset + 12, true);
            colors[i * 3 + 0] = (colorEnc & 0xFF) / 255;         // R
            colors[i * 3 + 1] = ((colorEnc >> 8) & 0xFF) / 255;  // G  
            colors[i * 3 + 2] = ((colorEnc >> 16) & 0xFF) / 255; // B
            
            // Opacity from alpha channel
            opacities[i] = ((colorEnc >> 24) & 0xFF) / 255;
            
            // Scale: bytes 16-21 (6 bytes = 3x uint16)
            const scaleX = view.getUint16(offset + 16, true) / 65535;
            const scaleY = view.getUint16(offset + 18, true) / 65535;
            const scaleZ = view.getUint16(offset + 20, true) / 65535;
            
            // Interpolate scale using min/max from meta.lcc
            scales[i * 3 + 0] = this.lerp(scaleAttr.min[0], scaleAttr.max[0], scaleX);
            scales[i * 3 + 1] = this.lerp(scaleAttr.min[1], scaleAttr.max[1], scaleY);
            scales[i * 3 + 2] = this.lerp(scaleAttr.min[2], scaleAttr.max[2], scaleZ);
            
            // Rotation: bytes 22-25 (uint32 compressed quaternion)
            const rotEnc = view.getUint32(offset + 22, true);
            const quat = this.decodeRotation(rotEnc);
            
            rotations[i * 4 + 0] = quat[0];
            rotations[i * 4 + 1] = quat[1];
            rotations[i * 4 + 2] = quat[2];
            rotations[i * 4 + 3] = quat[3];
            
            // Compute 3D covariance matrix from scale and rotation
            const cov = this.computeCov3D(
                [scales[i * 3 + 0], scales[i * 3 + 1], scales[i * 3 + 2]],
                [rotations[i * 4 + 0], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3]]
            );
            
            cov3Ds[i * 6 + 0] = cov[0];
            cov3Ds[i * 6 + 1] = cov[1];
            cov3Ds[i * 6 + 2] = cov[2];
            cov3Ds[i * 6 + 3] = cov[3];
            cov3Ds[i * 6 + 4] = cov[4];
            cov3Ds[i * 6 + 5] = cov[5];
            
            // Progress update every 10000 splats
            if (i % 10000 === 0) {
                onProgress(0.2 + 0.6 * (i / splatCount));
            }
        }
        
        return {
            splatCount,
            positions,
            colors,
            opacities,
            scales,
            rotations,
            cov3Ds
        };
    }

    /**
     * Decode compressed rotation quaternion
     * Based on LCC spec DecodeRotation function
     */
    decodeRotation(enc) {
        const QLut = [3, 0, 1, 2, 0, 3, 1, 2, 0, 1, 3, 2, 0, 1, 2, 3];
        const sqrt2 = 1.414213562373095;
        const rsqrt2 = 0.7071067811865475;
        
        // Unpack 10+10+10+2 bits
        const pq = [
            (enc & 1023) / 1023.0,
            ((enc >> 10) & 1023) / 1023.0,
            ((enc >> 20) & 1023) / 1023.0,
            ((enc >> 30) & 3) / 3.0
        ];
        
        const idx = Math.round(pq[3] * 3.0);
        
        // Decode quaternion components
        const q = [
            pq[0] * sqrt2 - rsqrt2,
            pq[1] * sqrt2 - rsqrt2,
            pq[2] * sqrt2 - rsqrt2,
            0
        ];
        
        // Compute w from unit quaternion constraint
        const dot = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
        q[3] = Math.sqrt(Math.max(0, 1.0 - Math.min(1, dot)));
        
        // Reorder based on lookup table
        const p = [
            q[QLut[idx * 4 + 0]],
            q[QLut[idx * 4 + 1]],
            q[QLut[idx * 4 + 2]],
            q[QLut[idx * 4 + 3]]
        ];
        
        return p;
    }

    /**
     * Compute 3D covariance matrix from scale and rotation
     * Based on original 3DGS implementation
     */
    computeCov3D(scale, rot) {
        // Create scale matrix
        const S = [
            scale[0], 0, 0,
            0, scale[1], 0,
            0, 0, scale[2]
        ];
        
        // Create rotation matrix from quaternion (w, x, y, z)
        const r = rot[3]; // w
        const x = rot[0];
        const y = rot[1];
        const z = rot[2];
        
        const R = [
            1 - 2 * (y * y + z * z), 2 * (x * y - r * z), 2 * (x * z + r * y),
            2 * (x * y + r * z), 1 - 2 * (x * x + z * z), 2 * (y * z - r * x),
            2 * (x * z - r * y), 2 * (y * z + r * x), 1 - 2 * (x * x + y * y)
        ];
        
        // M = S * R
        const M = this.mat3Multiply(S, R);
        
        // Sigma = M^T * M
        const MT = this.mat3Transpose(M);
        const Sigma = this.mat3Multiply(MT, M);
        
        // Return upper triangle (symmetric matrix)
        return [
            Sigma[0], Sigma[1], Sigma[2],
            Sigma[4], Sigma[5], Sigma[8]
        ];
    }

    /**
     * 3x3 matrix multiply
     */
    mat3Multiply(a, b) {
        const result = new Array(9);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                result[i * 3 + j] = 
                    a[i * 3 + 0] * b[0 * 3 + j] +
                    a[i * 3 + 1] * b[1 * 3 + j] +
                    a[i * 3 + 2] * b[2 * 3 + j];
            }
        }
        return result;
    }

    /**
     * 3x3 matrix transpose
     */
    mat3Transpose(m) {
        return [
            m[0], m[3], m[6],
            m[1], m[4], m[7],
            m[2], m[5], m[8]
        ];
    }

    /**
     * Linear interpolation
     */
    lerp(a, b, t) {
        return a + (b - a) * t;
    }

    /**
     * Parse spherical harmonic coefficients (Quality mode)
     * 64 bytes per splat
     */
    parseShcoef(buffer) {
        const BYTES_PER_SH = 64;
        const splatCount = Math.floor(buffer.byteLength / BYTES_PER_SH);
        const view = new DataView(buffer);
        
        // 15 SH coefficients per splat (3rd order = 16 total, minus DC term)
        const shCoeffs = new Float32Array(splatCount * 15 * 3);
        
        const shAttr = this.attributes.shcoef || {
            min: [-1, -1, -1],
            max: [1, 1, 1]
        };
        
        for (let i = 0; i < splatCount; i++) {
            const offset = i * BYTES_PER_SH;
            
            // Load 16 uint32 values (64 bytes)
            const raw = [];
            for (let j = 0; j < 16; j++) {
                raw.push(view.getUint32(offset + j * 4, true));
            }
            
            // Decode 15 SH coefficients using DecodePacked11
            for (let j = 0; j < 15; j++) {
                const enc = raw[j];
                const decoded = this.decodePacked11(enc);
                
                // Interpolate using min/max
                shCoeffs[i * 45 + j * 3 + 0] = this.lerp(shAttr.min[0], shAttr.max[0], decoded[0]);
                shCoeffs[i * 45 + j * 3 + 1] = this.lerp(shAttr.min[1], shAttr.max[1], decoded[1]);
                shCoeffs[i * 45 + j * 3 + 2] = this.lerp(shAttr.min[2], shAttr.max[2], decoded[2]);
            }
        }
        
        return shCoeffs;
    }

    /**
     * Decode packed 11-10-11 bit encoding for SH
     */
    decodePacked11(enc) {
        return [
            (enc & 2047) / 2047.0,
            ((enc >> 11) & 1023) / 1023.0,
            ((enc >> 21) & 2047) / 2047.0
        ];
    }
}

