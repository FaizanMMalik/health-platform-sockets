require('dotenv').config();

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const BASE_URL = process.env.BASE_URL;

const storage = multer.diskStorage({

    destination: async (req, file, cb) => {

        const dir = path.join(__dirname, '../public/uploads/images');

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

const upload = multer({ storage });


router.post('/get-image', upload.single('image'), async (req, res) => {

    try {

        if (!req.file) {

            return res.status(400).json({
                status: false,
                message: 'No file uploaded'
            });

        }

        // fallback agar .env mein BASE_URL na ho
        const baseUrl =
            BASE_URL || req.protocol + '://' + req.get('host');


        const filePath = `/public/uploads/images/${req.file.filename}`;

        const fileUrl = baseUrl + filePath;

        const fileName = path.basename(filePath, path.extname(filePath));


        return res.status(200).json({

            status: true,

            url: fileUrl,

            ID: fileName,

            message: 'Image Uploaded Successfully'

        });

    } catch (error) {

        return res.status(500).json({

            status: false,

            error: error.message

        });

    }

});


module.exports = router;