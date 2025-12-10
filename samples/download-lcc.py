#!/usr/bin/env python3
"""
Download LCC files from CloudFront CDN
"""

import requests
import os
from urllib.parse import urljoin

# Base URLs from test-lcc-access.py
lcc_meta_url = "https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2.lcc"
# Try both possible base URLs
data_base_options = [
    "https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/",
    "https://da9i2vj1xvtoc.cloudfront.net/lcc-model/showroom+level+2/showroom2/",
]

# Output directory
output_dir = "lcc-sample-level2"
os.makedirs(output_dir, exist_ok=True)

# Files to download - we'll try both base URLs for each
base_files = [
    "meta.lcc",
    "index.bin",
    "data.bin",
    "environment.bin",
]

# Start with the main meta file
files_to_download = [
    (lcc_meta_url, "meta.lcc"),
]

# Add data files with both possible URLs to try
for filename in base_files[1:]:  # Skip meta.lcc since we already have it
    for base_url in data_base_options:
        files_to_download.append((urljoin(base_url, filename), filename))

def download_file(url, filename, skip_if_exists=True):
    """Download a file from URL to output directory"""
    filepath = os.path.join(output_dir, filename)
    
    if skip_if_exists and os.path.exists(filepath):
        return 'exists'
    
    try:
        response = requests.get(url, timeout=30, stream=True)
        
        if response.status_code == 200:
            with open(filepath, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
            print(f"✅ {filename}")
            return True
        else:
            return False
            
    except Exception as e:
        return False

# Download all files
print(f"Downloading to {output_dir}/")

downloaded_files = set()

for url, filename in files_to_download:
    if filename in downloaded_files:
        continue
        
    result = download_file(url, filename)
    if result == 'exists' or result:
        downloaded_files.add(filename)

# Summary
expected_files = set([f for _, f in files_to_download])
if len(downloaded_files) == len(expected_files):
    print(f"✅ Complete ({len(downloaded_files)} files)")
else:
    missing = expected_files - downloaded_files
    print(f"⚠️  Missing: {', '.join(missing)}")
