const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const B2 = require('backblaze-b2');
const slugify = require('slugify');

const app = express();
const PORT = 3001;

// Paths
const ROOT_DIR = path.join(__dirname, '..');
const POSTS_DIR = path.join(ROOT_DIR, '_posts');
const DATA_DIR = path.join(ROOT_DIR, '_data', 'virtual-photography');
const B2_CONFIG_PATH = path.join(ROOT_DIR, '.b2-config.json');
const ALBUM_ORDER_PATH = path.join(DATA_DIR, '_album-order.json');

// Load B2 config
let b2Config;
try {
    b2Config = JSON.parse(fs.readFileSync(B2_CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error('Error loading .b2-config.json:', err.message);
    console.error('Make sure .b2-config.json exists in the root directory');
    process.exit(1);
}

// Initialize B2
const b2 = new B2({
    applicationKeyId: b2Config.application_key_id,
    applicationKey: b2Config.application_key
});

let b2AuthData = null;
let b2BucketId = null;
let b2AuthExpiry = 0;

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer config for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'));
        }
    }
});

// Helper: Authorize B2
async function authorizeB2(forceRefresh = false) {
    const now = Date.now();
    // Reauthorize if no auth data, expired (23 hours), or forced
    if (!b2AuthData || now > b2AuthExpiry || forceRefresh) {
        console.log('Authorizing B2...');
        b2AuthData = await b2.authorize();
        b2AuthExpiry = now + (23 * 60 * 60 * 1000); // 23 hours
        
        // Get bucket ID - try from config first, then from API
        if (b2Config.bucket_id) {
            b2BucketId = b2Config.bucket_id;
            console.log('B2 authorized. Using bucket ID from config:', b2BucketId);
        } else {
            try {
                const buckets = await b2.listBuckets();
                const bucket = buckets.data.buckets.find(b => b.bucketName === b2Config.bucket_name);
                if (bucket) {
                    b2BucketId = bucket.bucketId;
                    console.log('B2 authorized. Bucket ID:', b2BucketId);
                } else {
                    throw new Error(`Bucket ${b2Config.bucket_name} not found`);
                }
            } catch (e) {
                // If listBuckets fails, we need bucket_id in config
                console.error('Cannot list buckets. Please add "bucket_id" to .b2-config.json');
                throw new Error('bucket_id required in config when using limited app key');
            }
        }
    }
    return b2AuthData;
}

// Helper: Upload file to B2
async function uploadToB2(fileName, fileBuffer, contentType) {
    await authorizeB2();
    const uploadUrl = await b2.getUploadUrl({ bucketId: b2BucketId });
    
    const response = await b2.uploadFile({
        uploadUrl: uploadUrl.data.uploadUrl,
        uploadAuthToken: uploadUrl.data.authorizationToken,
        fileName: fileName,
        data: fileBuffer,
        contentType: contentType
    });
    
    return response.data;
}

// Helper: Delete file from B2
async function deleteFromB2(fileName) {
    await authorizeB2();
    
    // First, get file versions
    const files = await b2.listFileVersions({
        bucketId: b2BucketId,
        prefix: fileName,
        maxFileCount: 1
    });
    
    if (files.data.files.length > 0) {
        const file = files.data.files[0];
        await b2.deleteFileVersion({
            fileId: file.fileId,
            fileName: file.fileName
        });
        return true;
    }
    return false;
}

// Helper: Get CDN URL
function getCdnUrl(filePath) {
    if (b2Config.use_cdn && b2Config.cdn_domain) {
        return `https://${b2Config.cdn_domain}/${filePath}`;
    }
    return `https://f003.backblazeb2.com/file/${b2Config.bucket_name}/${filePath}`;
}

// Helper: Read all albums
function getAlbums() {
    const albums = [];
    
    // Read all JSON files in data directory
    const jsonFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    
    for (const jsonFile of jsonFiles) {
        const slug = jsonFile.replace('.json', '');
        const jsonPath = path.join(DATA_DIR, jsonFile);
        
        // Find corresponding post file
        const postFiles = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith(`${slug}.md`));
        
        if (postFiles.length > 0) {
            const postPath = path.join(POSTS_DIR, postFiles[0]);
            const postContent = fs.readFileSync(postPath, 'utf8');
            
            // Parse front matter
            const frontMatterMatch = postContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (frontMatterMatch) {
                const frontMatter = {};
                frontMatterMatch[1].split(/\r?\n/).forEach(line => {
                    const match = line.match(/^([\w-]*?):\s*(.*)$/);
                    if (match) {
                        let value = match[2].trim();
                        // Remove quotes if present
                        if ((value.startsWith('"') && value.endsWith('"')) || 
                            (value.startsWith("'") && value.endsWith("'"))) {
                            value = value.slice(1, -1);
                        }
                        // Parse arrays
                        if (value.startsWith('[') && value.endsWith(']')) {
                            value = value.slice(1, -1).split(',').map(v => v.trim());
                        }
                        frontMatter[match[1]] = value;
                    }
                });
                
                // Read images
                let images = [];
                try {
                    const rawImages = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    // Normalize image data to handle both old and new formats
                    images = rawImages.map(img => ({
                        url: img.url || img['imageFull-link'] || '',
                        thumb: img.thumb || img['thumbnail-link'] || '',
                        aspectRatio: parseFloat(img.aspectRatio || img['aspect-ratio'] || 1.5),
                        width: img.width || 0,
                        height: img.height || 0
                    }));
                } catch (e) {
                    console.error(`Error reading ${jsonFile}:`, e.message);
                }
                
                // Parse tags
                let tags = [];
                if (frontMatter.tags) {
                    if (Array.isArray(frontMatter.tags)) {
                        tags = frontMatter.tags;
                    } else if (typeof frontMatter.tags === 'string') {
                        tags = frontMatter.tags.split(',').map(t => t.trim());
                    }
                }
                
                albums.push({
                    slug: slug,
                    title: frontMatter.title || slug,
                    description: frontMatter.description || 'Virtual Photography',
                    developer: frontMatter.developer || '',
                    date: frontMatter.date || '',
                    tags: tags,
                    cardImage: parseInt(frontMatter['card-image']) || 0,
                    cardOffset: parseInt(frontMatter['card-offset']) || 50,
                    cardOffsetX: parseInt(frontMatter['card-offset-x']) || 50,
                    cardZoom: parseInt(frontMatter['card-zoom']) || 100,
                    bannerImage: parseInt(frontMatter['banner-image']) || 0,
                    bannerOffset: parseInt(frontMatter['banner-offset']) || 50,
                    bannerOffsetX: parseInt(frontMatter['banner-offset-x']) || 50,
                    bannerZoom: parseInt(frontMatter['banner-zoom']) || 100,
                    images: images,
                    imageCount: images.length,
                    postFile: postFiles[0],
                    jsonFile: jsonFile
                });
            }
        }
    }
    
    // Sort by custom order if available, otherwise by date
    const order = getAlbumOrder();
    if (order.length > 0) {
        albums.sort((a, b) => {
            const aIndex = order.indexOf(a.slug);
            const bIndex = order.indexOf(b.slug);
            // If both are in order array, sort by order
            if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
            // If only one is in order array, put it first
            if (aIndex >= 0) return -1;
            if (bIndex >= 0) return 1;
            // Otherwise sort by date descending
            return new Date(b.date) - new Date(a.date);
        });
    } else {
        // Default: sort by date descending
        albums.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    
    return albums;
}

// Helper: Get single album
function getAlbum(slug) {
    const albums = getAlbums();
    return albums.find(a => a.slug === slug);
}

// Helper: Create slug
function createSlug(name) {
    return slugify(name, {
        lower: true,
        strict: true,
        remove: /[*+~.()'"!:@]/g
    });
}

// Helper: Generate post markdown
function generatePostMarkdown(data) {
    const date = data.date || new Date().toISOString().split('T')[0];
    const tagsArray = data.tags || [];
    const tagsLine = tagsArray.length > 0 ? `tags: [${tagsArray.join(', ')}]` : 'tags: []';
    
    // Escape YAML special characters by quoting strings
    const title = data.title ? `"${data.title.replace(/"/g, '\\"')}"` : '""';
    const description = data.description ? `"${data.description.replace(/"/g, '\\"')}"` : '"Virtual Photography"';
    const developer = data.developer ? `"${data.developer.replace(/"/g, '\\"')}"` : '""';
    
    return `---
layout: post
date: ${date}
title: ${title}
description: ${description}
developer: ${developer}
categories: [virtual-photography]
${tagsLine}
slug: ${data.slug}
card-image: ${data.cardImage || 0}
card-offset: ${data.cardOffset || 50}
card-offset-x: ${data.cardOffsetX || 50}
card-zoom: ${data.cardZoom || 100}
banner-image: ${data.bannerImage || 0}
banner-offset: ${data.bannerOffset || 50}
banner-offset-x: ${data.bannerOffsetX || 50}
banner-zoom: ${data.bannerZoom || 100}
---`;
}

// Routes

// Dashboard
app.get('/', (req, res) => {
    res.redirect('/upload');
});

app.get('/upload', (req, res) => {
    const albums = getAlbums();
    res.render('index', { albums });
});

// Create album page
app.get('/upload/new', (req, res) => {
    res.render('new-album');
});

// Create album
app.post('/upload/create', upload.array('images', 100), async (req, res) => {
    try {
        const { title, developer, description, date } = req.body;
        const slug = createSlug(title);
        const actualDate = date || new Date().toISOString().split('T')[0];
        
        // Check if album already exists
        const jsonPath = path.join(DATA_DIR, `${slug}.json`);
        if (fs.existsSync(jsonPath)) {
            return res.status(400).json({ error: 'Album with this name already exists' });
        }
        
        // Process and upload images
        const images = [];
        const files = req.files || [];
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const imgNum = String(i).padStart(3, '0');
            
            // Get image dimensions
            const metadata = await sharp(file.buffer).metadata();
            const aspectRatio = Math.round((metadata.width / metadata.height) * 10000) / 10000;
            
            // Upload original
            const originalFileName = `${slug}/img${imgNum}.jpg`;
            let originalBuffer = file.buffer;
            
            // Convert to JPEG if not already
            if (file.mimetype !== 'image/jpeg') {
                originalBuffer = await sharp(file.buffer)
                    .jpeg({ quality: 95 })
                    .toBuffer();
            }
            
            await uploadToB2(originalFileName, originalBuffer, 'image/jpeg');
            
            // Generate and upload thumbnail
            const thumbBuffer = await sharp(file.buffer)
                .resize(600, null, { withoutEnlargement: true })
                .webp({ quality: 85 })
                .toBuffer();
            
            const thumbFileName = `${slug}/thumb/img${imgNum}.webp`;
            await uploadToB2(thumbFileName, thumbBuffer, 'image/webp');
            
            images.push({
                url: getCdnUrl(originalFileName),
                thumb: getCdnUrl(thumbFileName),
                aspectRatio: aspectRatio,
                width: metadata.width,
                height: metadata.height
            });
        }
        
        // Create JSON file
        fs.writeFileSync(jsonPath, JSON.stringify(images, null, 2));
        
        // Create post file
        const postFileName = `${actualDate}-${slug}.md`;
        const postPath = path.join(POSTS_DIR, postFileName);
        const postContent = generatePostMarkdown({
            title,
            developer,
            description,
            date: actualDate,
            slug,
            cardImage: 0,
            cardOffset: 50,
            cardOffsetX: 50,
            cardZoom: 100,
            bannerImage: 0,
            bannerOffset: 50,
            bannerOffsetX: 50,
            bannerZoom: 100
        });
        fs.writeFileSync(postPath, postContent);
        
        res.json({ 
            success: true, 
            slug,
            message: `Album "${title}" created with ${images.length} images`
        });
        
    } catch (err) {
        console.error('Error creating album:', err);
        res.status(500).json({ error: err.message });
    }
});

// Edit album page
app.get('/upload/edit/:slug', (req, res) => {
    const album = getAlbum(req.params.slug);
    if (!album) {
        return res.status(404).send('Album not found');
    }
    res.render('edit-album', { album });
});

// Update album metadata
app.post('/upload/update/:slug', (req, res) => {
    try {
        const album = getAlbum(req.params.slug);
        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }
        
        const { title, description, developer, date, tags, cardImage, cardOffset, cardOffsetX, cardZoom, bannerImage, bannerOffset, bannerOffsetX, bannerZoom } = req.body;
        
        // Parse tags if provided as string
        let parsedTags = album.tags;
        if (tags !== undefined) {
            if (typeof tags === 'string') {
                parsedTags = tags.split(',').map(t => t.trim()).filter(t => t);
            } else if (Array.isArray(tags)) {
                parsedTags = tags;
            }
        }
        
        // Determine the new date
        const newDate = date || album.date;
        const oldPostPath = path.join(POSTS_DIR, album.postFile);
        let newPostPath = oldPostPath;
        
        // If date changed, rename the post file
        if (date && date !== album.date) {
            const newFileName = `${date}-${album.slug}.md`;
            newPostPath = path.join(POSTS_DIR, newFileName);
            
            // Rename file if it exists
            if (fs.existsSync(oldPostPath)) {
                fs.renameSync(oldPostPath, newPostPath);
            }
        }
        
        // Generate new content
        const postContent = generatePostMarkdown({
            title: title || album.title,
            description: description !== undefined ? description : album.description,
            developer: developer !== undefined ? developer : album.developer,
            date: newDate,
            tags: parsedTags,
            slug: album.slug,
            cardImage: cardImage !== undefined ? parseInt(cardImage) : album.cardImage,
            cardOffset: cardOffset !== undefined ? parseInt(cardOffset) : album.cardOffset,
            cardOffsetX: cardOffsetX !== undefined ? parseInt(cardOffsetX) : album.cardOffsetX,
            cardZoom: cardZoom !== undefined ? parseInt(cardZoom) : album.cardZoom,
            bannerImage: bannerImage !== undefined ? parseInt(bannerImage) : album.bannerImage,
            bannerOffset: bannerOffset !== undefined ? parseInt(bannerOffset) : album.bannerOffset,
            bannerOffsetX: bannerOffsetX !== undefined ? parseInt(bannerOffsetX) : album.bannerOffsetX,
            bannerZoom: bannerZoom !== undefined ? parseInt(bannerZoom) : album.bannerZoom
        });
        
        fs.writeFileSync(newPostPath, postContent);
        
        res.json({ success: true, message: 'Album updated' });
        
    } catch (err) {
        console.error('Error updating album:', err);
        res.status(500).json({ error: err.message });
    }
});

// Add images to album
app.post('/upload/add-images/:slug', upload.array('images', 100), async (req, res) => {
    try {
        const album = getAlbum(req.params.slug);
        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }
        
        const jsonPath = path.join(DATA_DIR, album.jsonFile);
        const images = [...album.images];
        const files = req.files || [];
        
        // Find next image number
        let nextNum = images.length;
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const imgNum = String(nextNum + i).padStart(3, '0');
            
            // Get image dimensions
            const metadata = await sharp(file.buffer).metadata();
            const aspectRatio = Math.round((metadata.width / metadata.height) * 10000) / 10000;
            
            // Upload original
            const originalFileName = `${album.slug}/img${imgNum}.jpg`;
            let originalBuffer = file.buffer;
            
            if (file.mimetype !== 'image/jpeg') {
                originalBuffer = await sharp(file.buffer)
                    .jpeg({ quality: 95 })
                    .toBuffer();
            }
            
            await uploadToB2(originalFileName, originalBuffer, 'image/jpeg');
            
            // Generate and upload thumbnail
            const thumbBuffer = await sharp(file.buffer)
                .resize(600, null, { withoutEnlargement: true })
                .webp({ quality: 85 })
                .toBuffer();
            
            const thumbFileName = `${album.slug}/thumb/img${imgNum}.webp`;
            await uploadToB2(thumbFileName, thumbBuffer, 'image/webp');
            
            images.push({
                url: getCdnUrl(originalFileName),
                thumb: getCdnUrl(thumbFileName),
                aspectRatio: aspectRatio,
                width: metadata.width,
                height: metadata.height
            });
        }
        
        // Update JSON file
        fs.writeFileSync(jsonPath, JSON.stringify(images, null, 2));
        
        res.json({ 
            success: true, 
            message: `Added ${files.length} images`,
            totalImages: images.length
        });
        
    } catch (err) {
        console.error('Error adding images:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete image from album
app.post('/upload/delete-image/:slug/:index', async (req, res) => {
    try {
        const album = getAlbum(req.params.slug);
        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }
        
        const index = parseInt(req.params.index);
        if (index < 0 || index >= album.images.length) {
            return res.status(400).json({ error: 'Invalid image index' });
        }
        
        const image = album.images[index];
        
        // Extract file paths from URLs
        const urlPath = new URL(image.url).pathname;
        const thumbPath = new URL(image.thumb).pathname;
        
        // Remove leading slash and bucket name if present
        const originalFile = urlPath.split('/').slice(-2).join('/');
        const thumbFile = thumbPath.split('/').slice(-3).join('/');
        
        // Delete from B2
        try {
            await deleteFromB2(originalFile);
            await deleteFromB2(thumbFile);
        } catch (e) {
            console.error('Error deleting from B2:', e.message);
        }
        
        // Update JSON
        const images = album.images.filter((_, i) => i !== index);
        const jsonPath = path.join(DATA_DIR, album.jsonFile);
        fs.writeFileSync(jsonPath, JSON.stringify(images, null, 2));
        
        res.json({ success: true, message: 'Image deleted' });
        
    } catch (err) {
        console.error('Error deleting image:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete album
app.post('/upload/delete/:slug', async (req, res) => {
    try {
        const album = getAlbum(req.params.slug);
        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }
        
        // Delete all images from B2
        for (const image of album.images) {
            try {
                const urlPath = new URL(image.url).pathname;
                const thumbPath = new URL(image.thumb).pathname;
                const originalFile = urlPath.split('/').slice(-2).join('/');
                const thumbFile = thumbPath.split('/').slice(-3).join('/');
                
                await deleteFromB2(originalFile);
                await deleteFromB2(thumbFile);
            } catch (e) {
                console.error('Error deleting file from B2:', e.message);
            }
        }
        
        // Delete local files
        const postPath = path.join(POSTS_DIR, album.postFile);
        const jsonPath = path.join(DATA_DIR, album.jsonFile);
        
        if (fs.existsSync(postPath)) fs.unlinkSync(postPath);
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        
        res.json({ success: true, message: 'Album deleted' });
        
    } catch (err) {
        console.error('Error deleting album:', err);
        res.status(500).json({ error: err.message });
    }
});

// Reorder images
app.post('/upload/reorder/:slug', (req, res) => {
    try {
        const album = getAlbum(req.params.slug);
        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }
        
        const { order } = req.body; // Array of indices in new order
        if (!Array.isArray(order)) {
            return res.status(400).json({ error: 'Invalid order array' });
        }
        
        // Reorder images
        const newImages = order.map(i => album.images[i]);
        
        // Save
        const jsonPath = path.join(DATA_DIR, album.jsonFile);
        fs.writeFileSync(jsonPath, JSON.stringify(newImages, null, 2));
        
        res.json({ success: true, message: 'Images reordered' });
        
    } catch (err) {
        console.error('Error reordering images:', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper: Get album order
function getAlbumOrder() {
    try {
        if (fs.existsSync(ALBUM_ORDER_PATH)) {
            const order = JSON.parse(fs.readFileSync(ALBUM_ORDER_PATH, 'utf8'));
            return order.filter(slug => slug !== null);
        }
    } catch (e) {
        console.error('Error reading album order:', e.message);
    }
    return [];
}

// Helper: Save album order
function saveAlbumOrder(order) {
    fs.writeFileSync(ALBUM_ORDER_PATH, JSON.stringify(order, null, 2));
}

// Get album order page
app.get('/upload/order', (req, res) => {
    const albums = getAlbums();
    const order = getAlbumOrder();
    
    // Sort albums by order, put unordered ones at the end
    const orderedAlbums = [];
    const unorderedAlbums = [];
    
    albums.forEach(album => {
        const orderIndex = order.indexOf(album.slug);
        if (orderIndex >= 0) {
            orderedAlbums[orderIndex] = album;
        } else {
            unorderedAlbums.push(album);
        }
    });
    
    // Filter out undefined entries and combine
    const sortedAlbums = orderedAlbums.filter(a => a).concat(unorderedAlbums);
    
    res.render('album-order', { albums: sortedAlbums, order });
});

// Save album order
app.post('/upload/save-order', (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) {
            return res.status(400).json({ error: 'Invalid order array' });
        }
        
        saveAlbumOrder(order);
        res.json({ success: true, message: 'Album order saved' });
        
    } catch (err) {
        console.error('Error saving album order:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🎮 Virtual Photography Admin Panel`);
    console.log(`   Running at: http://localhost:${PORT}/upload`);
    console.log(`   B2 Bucket: ${b2Config.bucket_name}`);
    console.log(`   CDN: ${b2Config.cdn_domain || 'Not configured'}\n`);
});