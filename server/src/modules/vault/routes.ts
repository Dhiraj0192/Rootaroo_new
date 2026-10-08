import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import { vaultUpload } from './controller';
import {
  createVaultDocumentSchema,
  updateVaultDocumentSchema,
  vaultDocumentQuerySchema,
  storeUserKeySchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Document CRUD
router.post('/', vaultUpload, validate(createVaultDocumentSchema), ctrl.uploadDocumentCtrl);
router.get('/', validate(vaultDocumentQuerySchema), ctrl.listDocumentsCtrl);
router.get('/summary', ctrl.getStorageUsageCtrl);

// Key management (per-user only — vault documents are private, not shared)
router.get('/keys/me', ctrl.getUserKeyCtrl);
router.post('/keys/me', validate(storeUserKeySchema), ctrl.storeUserKeyCtrl);

// Document routes (must come after static /keys routes to avoid prefix conflicts)
router.get('/:id', ctrl.getDocumentByIdCtrl);
router.patch('/:id', validate(updateVaultDocumentSchema), ctrl.updateDocumentCtrl);
router.delete('/:id', ctrl.deleteDocumentCtrl);

// Per-user wrapped key for a document
router.get('/:id/key', ctrl.getDocumentKeyCtrl);

// Hard delete (admin only, FR-130)
router.delete('/:id/hard', ctrl.hardDeleteDocumentCtrl);

export default router;