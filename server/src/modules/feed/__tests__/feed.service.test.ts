jest.mock('../../billing/socketGate', () => ({ emitToHousehold: jest.fn().mockResolvedValue(undefined) }));
import {
  createPost,
  getFeed,
  getPostById,
  deletePost,
  likePost,
  unlikePost,
  addComment,
  deleteComment,
  toggleCommentReaction,
  getComments,
} from '../service';
import * as models from '../../../database/models';
import sequelize from '../../../config/database';

// ── Mocks ──

const mockUser = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  displayName: 'Test User',
  avatarUrl: null,
  avatarEmoji: null,
  email: 'test@example.com',
};

const otherUserId = '660e8400-e29b-41d4-a716-446655440002';
const householdId = '770e8400-e29b-41d4-a716-446655440003';
const postId = '880e8400-e29b-41d4-a716-446655440004';
const commentId = '990e8400-e29b-41d4-a716-446655440005';

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    query: jest.fn().mockResolvedValue([]),
    fn: jest.fn((name: string) => name),
    col: jest.fn((name: string) => name),
  },
}));

jest.mock('../../../database/models', () => {
  const mockSequelize = {
    fn: jest.fn((name: string) => name),
    col: jest.fn((name: string) => name),
  };

  return {
    FeedPost: {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      findByPk: jest.fn(),
    },
    FeedLike: {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      sequelize: mockSequelize,
    },
    FeedComment: {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      findByPk: jest.fn(),
      destroy: jest.fn(),
      sequelize: mockSequelize,
    },
    CommentReaction: {
      create: jest.fn(),
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      destroy: jest.fn(),
    },
    FeedMedia: {
      bulkCreate: jest.fn(),
    },
    User: {
      findByPk: jest.fn(),
    },
    HouseholdMember: {
      findOne: jest.fn(),
      findAll: jest.fn(),
    },
    NotificationHistory: {
      create: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn(),
    },
    NotificationPreference: {
      findOne: jest.fn(),
    },
    Sequelize: mockSequelize,
  };
});

// ── Helpers ──

function fakePost(overrides: any = {}) {
  return {
    id: postId,
    householdId,
    userId: mockUser.id,
    content: 'Test post content',
    mediaType: 'text',
    createdAt: new Date('2026-07-10T12:00:00Z'),
    updatedAt: new Date('2026-07-10T12:00:00Z'),
    deletedAt: null,
    get: jest.fn((key: string) => {
      if (key === 'author') return mockUser;
      if (key === 'media') return [];
      return undefined;
    }),
    destroy: jest.fn(),
    ...overrides,
  };
}

function fakeComment(overrides: any = {}) {
  return {
    id: commentId,
    postId,
    userId: mockUser.id,
    content: 'Test comment',
    createdAt: new Date('2026-07-10T12:30:00Z'),
    updatedAt: new Date('2026-07-10T12:30:00Z'),
    deletedAt: null,
    get: jest.fn((key: string) => {
      if (key === 'author') return mockUser;
      return undefined;
    }),
    destroy: jest.fn(),
    ...overrides,
  };
}

function fakeLike() {
  return {
    id: 'aa0e8400-e29b-41d4-a716-446655440006',
    postId,
    userId: mockUser.id,
    destroy: jest.fn(),
  };
}

const modelsMock = models as jest.Mocked<typeof models>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ──

describe('Feed Service', () => {
  describe('createPost', () => {
    it('creates a text post and returns it with author info', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.HouseholdMember.findAll as jest.Mock).mockResolvedValue([
        { userId: 'user2' }, { userId: 'user3' },
      ]);
      (modelsMock.FeedPost.create as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedPost.findByPk as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedLike.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.FeedComment.findAll as jest.Mock).mockResolvedValue([]);

      const result = await createPost(mockUser.id, {
        content: 'Test post content',
      });

      expect(result.content).toBe('Test post content');
      expect(result.author.displayName).toBe('Test User');
      expect(result.mediaType).toBe('text');
      expect(result.likeCount).toBe(0);
      expect(modelsMock.FeedPost.create).toHaveBeenCalled();
    });

    it('throws ForbiddenError if user has no household', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        createPost(mockUser.id, { content: 'Test' }),
      ).rejects.toThrow('You must belong to a household');
    });
  });

  describe('getFeed', () => {
    it('returns paginated feed posts', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findAll as jest.Mock).mockResolvedValue([
        fakePost(),
      ]);
      (modelsMock.FeedLike.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.FeedComment.findAll as jest.Mock).mockResolvedValue([]);

      const result = await getFeed(mockUser.id, { limit: 20 });

      expect(result.posts).toHaveLength(1);
      expect(result.posts[0].content).toBe('Test post content');
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('returns hasMore when there are more posts than limit', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      const posts = Array(21)
        .fill(null)
        .map((_, i) =>
          fakePost({
            id: `post-${i}`,
            createdAt: new Date(Date.now() - i * 60000),
          }),
        );
      (modelsMock.FeedPost.findAll as jest.Mock).mockResolvedValue(posts);
      (modelsMock.FeedLike.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.FeedComment.findAll as jest.Mock).mockResolvedValue([]);

      const result = await getFeed(mockUser.id, { limit: 20 });

      expect(result.posts).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('post-19');
    });

    it('attaches each post\'s first comment as previewComment from one query', async () => {
      const querySpy = sequelize.query as unknown as jest.Mock;
      querySpy.mockClear();
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findAll as jest.Mock).mockResolvedValue([
        fakePost({ id: 'post-a' }),
        fakePost({ id: 'post-b' }),
      ]);
      (modelsMock.FeedLike.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.FeedComment.findAll as jest.Mock).mockResolvedValue([]);
      querySpy.mockResolvedValueOnce([
        { postId: 'post-a', id: 'c1', content: 'first!', authorName: 'Asha' },
        { postId: 'post-a', id: 'c2', content: 'same instant', authorName: 'Ram' },
      ]);

      const result = await getFeed(mockUser.id, { limit: 20 });

      expect(querySpy).toHaveBeenCalledTimes(1);
      expect(result.posts[0].previewComment).toEqual({
        id: 'c1',
        content: 'first!',
        author: { displayName: 'Asha' },
      });
      expect(result.posts[1].previewComment).toBeNull();
    });
  });

  describe('getPostById', () => {
    it('returns a single post by ID', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedLike.findAll as jest.Mock).mockResolvedValue([]);
      (modelsMock.FeedComment.findAll as jest.Mock).mockResolvedValue([]);

      const result = await getPostById(postId, mockUser.id);

      expect(result.id).toBe(postId);
      expect(result.content).toBe('Test post content');
    });

    it('throws NotFoundError for non-existent post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        getPostById(postId, mockUser.id),
      ).rejects.toThrow('Post not found');
    });
  });

  describe('likePost / unlikePost', () => {
    it('likes a post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedLike.findOne as jest.Mock).mockResolvedValue(null);
      (modelsMock.FeedLike.create as jest.Mock).mockResolvedValue(fakeLike());

      const result = await likePost(postId, mockUser.id);

      expect(result).toBe(true);
      expect(modelsMock.FeedLike.create).toHaveBeenCalled();
    });

    it('returns false if already liked (no-op)', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedLike.findOne as jest.Mock).mockResolvedValue(fakeLike());

      const result = await likePost(postId, mockUser.id);

      expect(result).toBe(false);
      expect(modelsMock.FeedLike.create).not.toHaveBeenCalled();
    });

    it('unlikes a post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      const like = fakeLike();
      (modelsMock.FeedLike.findOne as jest.Mock).mockResolvedValue(like);

      await unlikePost(postId, mockUser.id);

      expect(like.destroy).toHaveBeenCalled();
    });

    it('throws NotFoundError when unliking non-existent like', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedLike.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        unlikePost(postId, mockUser.id),
      ).rejects.toThrow('Like not found');
    });
  });

  describe('deletePost', () => {
    it('allows post author to delete their own post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      const post = fakePost();
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(post);

      await deletePost(postId, mockUser.id, 'member');

      expect(post.destroy).toHaveBeenCalled();
    });

    it('allows admin to delete any post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      const post = fakePost({ userId: otherUserId }); // someone else's post
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(post);

      await deletePost(postId, otherUserId, 'admin');

      expect(post.destroy).toHaveBeenCalled();
    });

    it('prevents non-owner, non-admin from deleting', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      const post = fakePost({ userId: otherUserId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(post);
      post.destroy = jest.fn();

      await expect(
        deletePost(postId, 'some-other-user', 'member'),
      ).rejects.toThrow('You can only delete your own posts');

      expect(post.destroy).not.toHaveBeenCalled();
    });
  });

  describe('comments', () => {
    it('adds a comment to a post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedComment.create as jest.Mock).mockResolvedValue(
        fakeComment(),
      );
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(
        fakeComment(),
      );
      (modelsMock.User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      const result = await addComment(postId, mockUser.id, {
        content: 'Test comment',
      });

      expect(result.content).toBe('Test comment');
      expect(result.author.displayName).toBe('Test User');
    });

    it('allows self-deletion of comment', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      const comment = fakeComment();
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(comment);

      await deleteComment(commentId, mockUser.id, 'member');

      expect(comment.destroy).toHaveBeenCalled();
    });

    it('allows admin to delete any comment', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      const comment = fakeComment({ userId: otherUserId });
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(comment);

      await deleteComment(commentId, otherUserId, 'admin');

      expect(comment.destroy).toHaveBeenCalled();
    });

    it('prevents non-owner, non-admin from deleting a comment', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      const comment = fakeComment({ userId: otherUserId });
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(comment);
      comment.destroy = jest.fn();

      await expect(
        deleteComment(commentId, 'stranger', 'member'),
      ).rejects.toThrow('You can only delete your own comments');

      expect(comment.destroy).not.toHaveBeenCalled();
    });

    it('rejects deleting a comment whose post belongs to a different household (F-15)', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(null); // post not found in caller's household
      const comment = fakeComment();
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(comment);

      await expect(deleteComment(commentId, mockUser.id, 'admin')).rejects.toThrow('Comment');
      expect(comment.destroy).not.toHaveBeenCalled();
    });

    it('rejects reacting to a comment whose post belongs to a different household (F-15)', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(null);
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(fakeComment());

      await expect(toggleCommentReaction(commentId, mockUser.id, '👍')).rejects.toThrow('Comment');
    });

    it('allows reacting to a comment within the caller\'s household', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({ householdId });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedComment.findByPk as jest.Mock).mockResolvedValue(fakeComment());
      (modelsMock.CommentReaction.findOne as jest.Mock).mockResolvedValue(null);
      (modelsMock.CommentReaction.create as jest.Mock).mockResolvedValue(undefined);
      (modelsMock.CommentReaction.count as jest.Mock) = jest.fn().mockResolvedValue(1);

      const result = await toggleCommentReaction(commentId, mockUser.id, '👍');

      expect(result.reacted).toBe(true);
    });

    it('returns paginated comments for a post', async () => {
      (modelsMock.HouseholdMember.findOne as jest.Mock).mockResolvedValue({
        householdId,
      });
      (modelsMock.FeedPost.findOne as jest.Mock).mockResolvedValue(fakePost());
      (modelsMock.FeedComment.findAll as jest.Mock).mockResolvedValue([
        fakeComment(),
      ]);

      const result = await getComments(postId, mockUser.id, { limit: 20 });

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].content).toBe('Test comment');
    });
  });
});
