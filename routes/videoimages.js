require('dotenv').config();

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const BASE_URL = process.env.BASE_URL;

// Determine file type
const getFileType = (file) => {

    if (file.mimetype.startsWith('image/')) {
        return 'images';
    }

    if (file.mimetype.startsWith('video/')) {
        return 'videos';
    }

    if (
        file.mimetype === 'application/dicom' ||
        path.extname(file.originalname).toLowerCase() === '.dcm'
    ) {
        return 'dicom';
    }

    return 'other';
};

const storage = multer.diskStorage({

    destination: async (req, file, cb) => {

        const fileType = getFileType(file);

        const dir = path.join(
            __dirname,
            `../public/uploads/${fileType}`
        );

        try {

            await fs.mkdir(dir, { recursive: true });

            cb(null, dir);

        } catch (error) {

            cb(error);

        }

    },

    filename: (req, file, cb) => {

        const uniqueSuffix =
            Date.now() + '-' + Math.round(Math.random() * 1E9);

        cb(null, uniqueSuffix + path.extname(file.originalname));

    }

});

const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    }
});


router.post('/upload-files', upload.array('files[]', 10), async (req, res) => {

    try {

        console.log(req.body);
        console.log(req.files);

        if (!req.files || req.files.length === 0) {

            return res.status(400).json({
                status: false,
                message: 'No files uploaded'
            });

        }

        const baseUrl =
            BASE_URL || req.protocol + '://' + req.get('host');

        const uploadedFiles = req.files.map(file => {

            const fileType = getFileType(file);

            const filePath =
                `/public/uploads/${fileType}/${file.filename}`;

            const fileUrl = baseUrl + filePath;

            const fileName =
                path.basename(filePath, path.extname(filePath));

            return {

                url: fileUrl,

                ID: fileName,

                type: fileType

            };

        });

        return res.status(200).json({

            status: true,

            files: uploadedFiles,

            message: 'Files Uploaded Successfully'

        });

    } catch (error) {

        console.error(error);

        return res.status(500).json({

            status: false,

            error: error.message

        });

    }

});

module.exports = router;