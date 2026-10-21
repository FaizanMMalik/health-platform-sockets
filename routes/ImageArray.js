require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');

const router = express.Router();

const BASE_URL = process.env.BASE_URL;

// Storage configuration
const storage = multer.diskStorage({

    destination: async (req, file, cb) => {
        try {

            // rapid_test-31[] OR lab_test-31[]
            const match = file.fieldname.match(/(rapid_test|lab_test)-(\d+)\[\]$/);

            if (!match) {
                return cb(new Error('Invalid field name'));
            }

            const type = match[1];
            const id = match[2];

            const dir = path.join(
                __dirname,
                `../public/uploads/${type.replace('_', '-')}-${id}`
            );

            await fs.mkdir(dir, { recursive: true });

            cb(null, dir);

        } catch (error) {
            cb(error);
        }
    },

    filename: (req, file, cb) => {

        const uniqueName =
            Date.now() +
            "-" +
            file.originalname.replace(/\s+/g, "-");

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB
    }
});


// Upload endpoint
router.post('/upload', upload.any(), async (req, res) => {

    try {

        if (!req.files || req.files.length === 0) {

            return res.status(400).json({
                success: false,
                message: "No files uploaded"
            });
        }

        const uploadedFiles = {};

        for (const file of req.files) {

            const match = file.fieldname.match(/(rapid_test|lab_test)-(\d+)\[\]$/);

            if (!match) continue;

            const type = match[1];
            const id = match[2];

            const cleanFieldName = `${type}-${id}`;

            const fileUrl =
                `${BASE_URL}/public/uploads/${type.replace('_', '-')}-${id}/${file.filename}`;

            if (!uploadedFiles[cleanFieldName]) {
                uploadedFiles[cleanFieldName] = [];
            }

            uploadedFiles[cleanFieldName].push({
                url: fileUrl
            });
        }

        return res.status(200).json({
            success: true,
            files: uploadedFiles
        });

    } catch (error) {

        console.error("Upload error:", error);

        return res.status(500).json({
            success: false,
            message: "Upload failed",
            error: error.message
        });
    }
});

module.exports = router;