import multer from 'multer';
import { ValidationError } from '../utils/errors';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
const ALLOWED = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
const AUDIO_EXTENSIONS = ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.webm', '.caf'];

const imageFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  if (IMAGE_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`Only images (${IMAGE_EXTENSIONS.join(', ')}) are allowed.`));
  }
};

const mediaFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  if (ALLOWED.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`Only images and videos (${ALLOWED.join(', ')}) are allowed.`));
  }
};

const audioFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  if (AUDIO_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new ValidationError(`Only audio files (${AUDIO_EXTENSIONS.join(', ')}) are allowed.`));
  }
};

const memory = multer.memoryStorage();

export const uploadAvatar = multer({
  storage: memory,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('avatar');

export const uploadHouseholdCover = multer({
  storage: memory,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('cover');

export const uploadFeedMedia = multer({
  storage: memory,
  fileFilter: mediaFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (covers max 2min 720p video)
});

// Journal photos arrive already encrypted by the phone, so they are opaque bytes:
// no image type or extension check is possible (or wanted) here.
const ciphertextFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (file.mimetype === 'application/octet-stream') {
    cb(null, true);
  } else {
    cb(new ValidationError('Journal uploads must be encrypted (application/octet-stream).'));
  }
};

export const uploadJournalBlobs = multer({
  storage: memory,
  fileFilter: ciphertextFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }, // 5 files x 10 MB per request
});

export const uploadChatVoice = multer({
  storage: memory,
  fileFilter: audioFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB (short voice notes)
});

export const uploadChatImage = multer({
  storage: memory,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});
