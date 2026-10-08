import { Request, Response, NextFunction } from 'express';
import * as vaultService from './service';
import multer from 'multer';
import { ValidationError } from '../../shared/utils/errors';

export const vaultUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
}).single('file');

function getUserId(req: Request): string {
  return (req as any).user!.userId;
}

export async function uploadDocumentCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.file) {
      return next(new ValidationError('No file uploaded'));
    }

    const document = await vaultService.uploadDocument(
      getUserId(req),
      req.body.meta,
      req.file.buffer
    );

    res.status(201).json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
}

export async function listDocumentsCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await vaultService.listDocuments(getUserId(req), req.query);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

export async function listMembersCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const members = await vaultService.listVaultMembers(getUserId(req));
    res.json({ success: true, data: members });
  } catch (error) {
    next(error);
  }
}

export async function listPendingGrantsCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const grants = await vaultService.listPendingGrants(getUserId(req));
    res.json({ success: true, data: grants });
  } catch (error) {
    next(error);
  }
}

export async function getDocumentByIdCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const document = await vaultService.getDocumentById(req.params.id, getUserId(req));
    res.json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
}

export async function grantKeysCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await vaultService.grantKeys(req.params.id, getUserId(req), req.body.grants);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function renameDocumentCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const document = await vaultService.renameDocument(req.params.id, getUserId(req), req.body.sealedMeta);
    res.json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
}

export async function changeScopeCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const document = await vaultService.changeScope(req.params.id, getUserId(req), req.body);
    res.json({ success: true, data: document });
  } catch (error) {
    next(error);
  }
}

export async function deleteDocumentCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await vaultService.deleteDocument(req.params.id, getUserId(req));
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

export async function getStorageUsageCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const usage = await vaultService.getStorageUsage(getUserId(req));
    res.json({ success: true, data: usage });
  } catch (error) {
    next(error);
  }
}
