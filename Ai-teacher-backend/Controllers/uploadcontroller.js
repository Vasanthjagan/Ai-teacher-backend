const path = require("path");
const fs = require("fs");

exports.handleUpload = (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
    }

    res.json({
        message: "File uploaded successfully",
        filePath: req.file.path
    });
};
