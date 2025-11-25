// middlewares/uploadMedia.js
import multer from "multer";
import path from "path";
import fs from "fs";

const uploadDir = path.resolve("uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

export const uploadMedia = (allowedTypes = ["image"], maxSizeMB = 0, perTypeLimitsMB = {}) => {
  // Compute a per-request hard cap (multer-level) as the maximum of all type limits
  const imageMax = Number(perTypeLimitsMB.image || process.env.IMAGE_MAX_MB || 10);
  const videoMax = Number(perTypeLimitsMB.video || process.env.VIDEO_MAX_MB || 50);
  const audioMax = Number(perTypeLimitsMB.audio || process.env.AUDIO_MAX_MB || 20);
  const pdfMax = Number(perTypeLimitsMB.pdf || process.env.PDF_MAX_MB || 10);
  const hardCapMB = Math.max(imageMax, videoMax, audioMax, pdfMax);

  return multer({
    storage,
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const mime = file.mimetype.toLowerCase();

      // Determine type from extension
      let fileType = null;
      if ([".jpg", ".jpeg", ".png"].includes(ext)) fileType = "image";
      else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) fileType = "video";
      else if ([".mp3", ".wav", ".aac", ".m4a", ".ogg"].includes(ext)) fileType = "audio";
      else if ([".pdf"].includes(ext)) fileType = "pdf";

      if (!fileType || !allowedTypes.includes(fileType)) {
        return cb(new Error(`Only ${allowedTypes.join(" or ")} files allowed`));
      }

      // Note: Multer hard cap enforces size. We only classify type here.

      return cb(null, true);
    },
    limits: { fileSize: hardCapMB * 1024 * 1024 },
  });
};

// Route-level error handler to convert Multer size errors into informative JSON with env-based limits
export const uploadLimitErrorHandler = (err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || /file too large/i.test(err.message))) {
    const imageMax = Number(process.env.IMAGE_MAX_MB || 10);
    const videoMax = Number(process.env.VIDEO_MAX_MB || 50);
    const audioMax = Number(process.env.AUDIO_MAX_MB || 20);
    const pdfMax = Number(process.env.PDF_MAX_MB || 10);
    return res.status(413).json({
      error: "File too large",
      limits: { imageMaxMB: imageMax, videoMaxMB: videoMax, audioMaxMB: audioMax, pdfMaxMB: pdfMax }
    });
  }
  return next(err);
};
