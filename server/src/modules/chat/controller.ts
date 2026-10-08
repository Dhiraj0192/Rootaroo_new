import { Request, Response, NextFunction } from 'express';
import * as chatService from './service';
import { uploadBuffer } from '../../shared/utils/s3';
import { userUploadFolder } from '../../shared/utils/uploadKeys';

function getUserId(req: Request): string {
  return (req as any).user!.userId;
}

function getUserRole(req: Request): string {
  return (req as any).user!.role;
}

export async function uploadVoiceCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }
    const durationSeconds = req.body.durationSeconds ? Number(req.body.durationSeconds) : null;
    const result = await uploadBuffer(file.buffer, userUploadFolder('chat/voice', getUserId(req)), file.mimetype, file.originalname.split('.').pop());
    // `url` here is the S3 key, not a real URL — the mobile client sends it
    // straight back as `mediaUrl` on the message body (no preview render in
    // between), and the message-list response resolves it to a signed URL
    // on read via chat/service.ts.
    res.status(201).json({
      success: true,
      data: { url: result.key, durationSeconds },
    });
  } catch (err) {
    next(err);
  }
}

export async function uploadChatImageCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, error: 'No file provided' });
      return;
    }
    const result = await uploadBuffer(file.buffer, userUploadFolder('chat/image', getUserId(req)), file.mimetype, file.originalname.split('.').pop());
    // Same shape as uploadVoiceCtrl — `url` is the S3 key, resolved to a
    // signed URL on read via chat/service.ts.
    res.status(201).json({
      success: true,
      data: { url: result.key },
    });
  } catch (err) {
    next(err);
  }
}

export async function sendMessageCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.sendMessage(getUserId(req), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function listMessagesCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.listMessages(getUserId(req), req.query as any);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getMessageByIdCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.getMessageById(req.params.id, getUserId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateMessageCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.updateMessage(req.params.id, getUserId(req), getUserRole(req), req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function deleteMessageCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await chatService.deleteMessage(req.params.id, getUserId(req), getUserRole(req));
    res.json({ success: true, data: { message: 'Message deleted' } });
  } catch (err) {
    next(err);
  }
}

export async function addReactionCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.addReaction(req.params.id, getUserId(req), req.body.emoji);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function removeReactionCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.removeReaction(req.params.id, getUserId(req), req.params.emoji as any);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ── Conversation Controllers ──

export async function createConversationCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.createConversation(getUserId(req), req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getUserConversationsCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await chatService.getUserConversations(getUserId(req));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function markConversationReadCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await chatService.markConversationRead(getUserId(req), req.params.id);
    res.json({ success: true, data: { message: 'Conversation marked as read' } });
  } catch (err) {
    next(err);
  }
}

export async function addParticipantCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await chatService.addParticipant(req.params.id, req.body.userId, getUserId(req));
    res.json({ success: true, data: { message: 'Participant added' } });
  } catch (err) {
    next(err);
  }
}

export async function inviteParticipantCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await chatService.inviteToGroup(req.params.id, req.body.userId, getUserId(req));
    res.json({ success: true, data: { message: 'Invite sent' } });
  } catch (err) {
    next(err);
  }
}

export async function removeParticipantCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await chatService.removeParticipant(req.params.id, req.params.userId, getUserId(req));
    res.json({ success: true, data: { message: 'Participant removed' } });
  } catch (err) {
    next(err);
  }
}

export async function deleteConversationCtrl(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await chatService.deleteConversation(req.params.id, getUserId(req));
    res.json({ success: true, data: { message: 'Conversation deleted' } });
  } catch (err) {
    next(err);
  }
}
