import { Sequelize } from 'sequelize';
import sequelize from '../../config/database';

import User from './User';
import RefreshToken from './RefreshToken';
import EmailVerification from './EmailVerification';
import PasswordReset from './PasswordReset';
import Household from './Household';
import HouseholdMember from './HouseholdMember';
import HouseholdActionRequest from './HouseholdActionRequest';
import Invitation from './Invitation';
import FeedPost from './FeedPost';
import FeedLike from './FeedLike';
import FeedComment from './FeedComment';
import CommentReaction from './CommentReaction';
import FeedMedia from './FeedMedia';
import Task from './Task';
import TaskAssignee from './TaskAssignee';
import GroceryItem from './GroceryItem';
import TodoItem from './TodoItem';
import Expense from './Expense';
import ExpenseParticipant from './ExpenseParticipant';
import Settlement from './Settlement';
import VaultDocument from './VaultDocument';
import VaultKey from './VaultKey';
import VaultDocumentKey from './VaultDocumentKey';
import ChatMessage from './ChatMessage';
import ChatReaction from './ChatReaction';
import CheckIn from './CheckIn';
import PingRequest from './PingRequest';
import SavedPlace from './SavedPlace';
import CalendarEvent from './CalendarEvent';
import CalendarSyncState from './CalendarSyncState';
import EventInvitee from './EventInvitee';
import NotificationPreference from './NotificationPreference';
import NotificationHistory from './NotificationHistory';
import DeviceToken from './DeviceToken';
import PhoneVerification from './PhoneVerification';
import PostTag from './PostTag';
import Conversation from './Conversation';
import ConversationParticipant from './ConversationParticipant';
import JournalEntry from './JournalEntry';
import JournalMedia from './JournalMedia';
import BillingCustomer from './BillingCustomer';
import BillingSubscription from './BillingSubscription';
import BillingCheckoutSession from './BillingCheckoutSession';
import BillingEvent from './BillingEvent';
import BillingTransaction from './BillingTransaction';
import BillingRoutingRule from './BillingRoutingRule';
import BillingPriceNotice from './BillingPriceNotice';
import BillingReconciliationRun from './BillingReconciliationRun';
import BillingReconciliationItem from './BillingReconciliationItem';
import AdminAuditLog from './AdminAuditLog';

const models = {
  User,
  RefreshToken,
  EmailVerification,
  PasswordReset,
  PhoneVerification,
  Household,
  HouseholdMember,
  HouseholdActionRequest,
  Invitation,
  FeedPost,
  FeedLike,
  FeedComment,
  CommentReaction,
  FeedMedia,
  PostTag,
  Conversation,
  ConversationParticipant,
  Task,
  TaskAssignee,
  GroceryItem,
  TodoItem,
  Expense,
  ExpenseParticipant,
  Settlement,
  VaultDocument,
  VaultKey,
  VaultDocumentKey,
  ChatMessage,
  ChatReaction,
  CheckIn,
  PingRequest,
  SavedPlace,
  CalendarEvent,
  CalendarSyncState,
  EventInvitee,
  NotificationPreference,
  NotificationHistory,
  DeviceToken,
  JournalEntry,
  JournalMedia,
  BillingCustomer,
  BillingSubscription,
  BillingCheckoutSession,
  BillingEvent,
  BillingTransaction,
  BillingRoutingRule,
  BillingPriceNotice,
  BillingReconciliationRun,
  BillingReconciliationItem,
  AdminAuditLog,
};

export function setupAssociations(): void {
  // ── User associations ──
  User.hasMany(RefreshToken, { foreignKey: 'user_id', as: 'refreshTokens' });
  RefreshToken.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  User.hasMany(EmailVerification, { foreignKey: 'user_id', as: 'emailVerifications' });
  EmailVerification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  User.hasMany(PhoneVerification, { foreignKey: 'user_id', as: 'phoneVerifications' });
  PhoneVerification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  User.hasMany(PasswordReset, { foreignKey: 'user_id', as: 'passwordResets' });
  PasswordReset.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  User.hasOne(NotificationPreference, { foreignKey: 'user_id', as: 'notificationPreferences' });
  NotificationPreference.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  User.hasMany(NotificationHistory, { foreignKey: 'user_id', as: 'notificationHistory' });
  NotificationHistory.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  User.hasMany(CalendarSyncState, { foreignKey: 'user_id', as: 'calendarSyncStates' });
  CalendarSyncState.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // ── Household associations ──
  Household.hasMany(HouseholdMember, { foreignKey: 'household_id', as: 'members' });
  HouseholdMember.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
  HouseholdMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  Household.hasMany(Invitation, { foreignKey: 'household_id', as: 'invitations' });
  Invitation.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
  Invitation.belongsTo(User, { foreignKey: 'invited_by', as: 'inviter' });

  Household.hasMany(HouseholdActionRequest, { foreignKey: 'household_id', as: 'actionRequests' });
  HouseholdActionRequest.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
  User.hasMany(HouseholdActionRequest, { foreignKey: 'requested_by', as: 'householdActionRequests' });
  HouseholdActionRequest.belongsTo(User, { foreignKey: 'requested_by', as: 'requester' });

  Household.hasMany(FeedPost, { foreignKey: 'household_id', as: 'feedPosts' });
  FeedPost.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(Task, { foreignKey: 'household_id', as: 'tasks' });
  Task.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(Expense, { foreignKey: 'household_id', as: 'expenses' });
  Expense.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(ChatMessage, { foreignKey: 'household_id', as: 'chatMessages' });
  ChatMessage.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(CalendarEvent, { foreignKey: 'household_id', as: 'calendarEvents' });
  CalendarEvent.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(CheckIn, { foreignKey: 'household_id', as: 'checkIns' });
  CheckIn.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(PingRequest, { foreignKey: 'household_id', as: 'pingRequests' });
  PingRequest.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(SavedPlace, { foreignKey: 'household_id', as: 'savedPlaces' });
  SavedPlace.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(GroceryItem, { foreignKey: 'household_id', as: 'groceryItems' });
  GroceryItem.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(TodoItem, { foreignKey: 'household_id', as: 'todoItems' });
  TodoItem.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(VaultDocument, { foreignKey: 'household_id', as: 'vaultDocuments' });
  VaultDocument.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(VaultKey, { foreignKey: 'household_id', as: 'vaultKeys' });
  VaultKey.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  Household.hasMany(Settlement, { foreignKey: 'household_id', as: 'settlements' });
  Settlement.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });

  // ── User ↔ Household (many-to-many via HouseholdMember) ──
  User.belongsToMany(Household, { through: HouseholdMember, foreignKey: 'user_id', otherKey: 'household_id', as: 'households' });
  Household.belongsToMany(User, { through: HouseholdMember, foreignKey: 'household_id', otherKey: 'user_id', as: 'users' });

  // ── Feed associations ──
  FeedPost.belongsTo(User, { foreignKey: 'user_id', as: 'author' });
  User.hasMany(FeedPost, { foreignKey: 'user_id', as: 'posts' });

  FeedPost.hasMany(FeedLike, { foreignKey: 'post_id', as: 'likes' });
  FeedLike.belongsTo(FeedPost, { foreignKey: 'post_id', as: 'post' });
  FeedLike.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  FeedPost.hasMany(FeedComment, { foreignKey: 'post_id', as: 'comments' });
  FeedComment.belongsTo(FeedPost, { foreignKey: 'post_id', as: 'post' });
  FeedComment.belongsTo(User, { foreignKey: 'user_id', as: 'author' });

  // Self-reference: comment → reply (tree chain)
  FeedComment.hasMany(FeedComment, { foreignKey: 'parent_id', as: 'replies', onDelete: 'CASCADE' });
  FeedComment.belongsTo(FeedComment, { foreignKey: 'parent_id', as: 'parent' });

  // Comment reactions
  FeedComment.hasMany(CommentReaction, { foreignKey: 'comment_id', as: 'reactions' });
  CommentReaction.belongsTo(FeedComment, { foreignKey: 'comment_id', as: 'comment' });
  CommentReaction.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  FeedPost.hasMany(FeedMedia, { foreignKey: 'post_id', as: 'media' });
  FeedMedia.belongsTo(FeedPost, { foreignKey: 'post_id', as: 'post' });

  FeedPost.hasMany(PostTag, { foreignKey: 'post_id', as: 'postTags' });
  PostTag.belongsTo(FeedPost, { foreignKey: 'post_id', as: 'post' });
  PostTag.belongsTo(User, { foreignKey: 'user_id', as: 'taggedUser' });
  User.hasMany(PostTag, { foreignKey: 'user_id', as: 'postTags' });

  // ── Journal associations ──
  Household.hasMany(JournalEntry, { foreignKey: 'household_id', as: 'journalEntries' });
  JournalEntry.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
  JournalEntry.belongsTo(User, { foreignKey: 'user_id', as: 'author' });
  User.hasMany(JournalEntry, { foreignKey: 'user_id', as: 'journalEntries' });

  JournalEntry.hasMany(JournalMedia, { foreignKey: 'entry_id', as: 'media' });
  JournalMedia.belongsTo(JournalEntry, { foreignKey: 'entry_id', as: 'entry' });

  // ── Task associations ──
  Task.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
  Task.belongsTo(User, { foreignKey: 'completed_by', as: 'completer' });
  User.hasMany(Task, { foreignKey: 'created_by', as: 'createdTasks' });

  Task.belongsToMany(User, { through: TaskAssignee, foreignKey: 'task_id', otherKey: 'user_id', as: 'assignees' });
  User.belongsToMany(Task, { through: TaskAssignee, foreignKey: 'user_id', otherKey: 'task_id', as: 'assignedTasks' });

  // ── Expense associations ──
  Expense.belongsTo(User, { foreignKey: 'paid_by', as: 'payer' });
  Expense.hasMany(ExpenseParticipant, { foreignKey: 'expense_id', as: 'participants' });
  ExpenseParticipant.belongsTo(Expense, { foreignKey: 'expense_id', as: 'expense' });
  ExpenseParticipant.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  Settlement.belongsTo(User, { foreignKey: 'from_user_id', as: 'fromUser' });
  Settlement.belongsTo(User, { foreignKey: 'to_user_id', as: 'toUser' });

  // ── Conversation associations ──
  Conversation.belongsTo(Household, { foreignKey: 'household_id', as: 'household' });
  Household.hasMany(Conversation, { foreignKey: 'household_id', as: 'conversations' });
  Conversation.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });

  Conversation.belongsToMany(User, { through: ConversationParticipant, foreignKey: 'conversation_id', otherKey: 'user_id', as: 'participants' });
  User.belongsToMany(Conversation, { through: ConversationParticipant, foreignKey: 'user_id', otherKey: 'conversation_id', as: 'conversations' });

  Conversation.hasMany(ChatMessage, { foreignKey: 'conversation_id', as: 'messages' });
  ChatMessage.belongsTo(Conversation, { foreignKey: 'conversation_id', as: 'conversation', constraints: false });

  // ── Chat associations ──
  ChatMessage.belongsTo(User, { foreignKey: 'sender_id', as: 'sender' });
  User.hasMany(ChatMessage, { foreignKey: 'sender_id', as: 'sentMessages' });

  ChatMessage.hasMany(ChatReaction, { foreignKey: 'message_id', as: 'reactions' });
  ChatReaction.belongsTo(ChatMessage, { foreignKey: 'message_id', as: 'message' });
  ChatReaction.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // Self-referencing reply
  ChatMessage.belongsTo(ChatMessage, { foreignKey: 'reply_to_id', as: 'replyTo' });
  ChatMessage.hasMany(ChatMessage, { foreignKey: 'reply_to_id', as: 'replies' });

  // ── Calendar associations ──
  CalendarEvent.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
  CalendarEvent.belongsToMany(User, {
    through: EventInvitee,
    foreignKey: 'calendar_event_id',
    otherKey: 'user_id',
    as: 'invitees',
  });
  User.belongsToMany(CalendarEvent, {
    through: EventInvitee,
    foreignKey: 'user_id',
    otherKey: 'calendar_event_id',
    as: 'invitedEvents',
  });

  // ── Check-In associations ──
  CheckIn.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // ── Ping request associations ──
  PingRequest.belongsTo(User, { foreignKey: 'requester_id', as: 'requester' });
  PingRequest.belongsTo(User, { foreignKey: 'target_user_id', as: 'target' });
  PingRequest.belongsTo(CheckIn, { foreignKey: 'check_in_id', as: 'checkIn' });

  // ── Saved place associations ──
  SavedPlace.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // ── Vault associations ──
  VaultDocument.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader' });
  VaultKey.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

  // Per-user wrapped AES keys for vault documents
  VaultDocument.hasMany(VaultDocumentKey, { foreignKey: 'document_id', as: 'documentKeys' });
  VaultDocumentKey.belongsTo(VaultDocument, { foreignKey: 'document_id', as: 'document' });
  VaultDocumentKey.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
  User.hasMany(VaultDocumentKey, { foreignKey: 'user_id', as: 'vaultDocumentKeys' });

  // HouseholdMember ↔ VaultKey (for key status lookups)
  HouseholdMember.hasOne(VaultKey, { foreignKey: 'user_id', sourceKey: 'userId', as: 'vaultKey' });

  // ── Grocery / Todo ──
  GroceryItem.belongsTo(User, { foreignKey: 'assigned_to', as: 'assignee' });
  GroceryItem.belongsTo(User, { foreignKey: 'bought_by', as: 'buyer' });
  TodoItem.belongsTo(User, { foreignKey: 'assigned_to', as: 'assignee' });
  TodoItem.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
  // -- Billing --
  BillingCustomer.belongsTo(Household, { foreignKey: 'householdId', as: 'household', constraints: false });
  BillingSubscription.belongsTo(Household, { foreignKey: 'householdId', as: 'household', constraints: false });
  BillingTransaction.belongsTo(Household, { foreignKey: 'householdId', as: 'household', constraints: false });
  BillingTransaction.belongsTo(BillingSubscription, { foreignKey: 'subscriptionId', as: 'subscription', constraints: false });
  BillingPriceNotice.belongsTo(BillingSubscription, { foreignKey: 'subscriptionId', as: 'subscription', constraints: false });
}

export {
  sequelize,
  Sequelize,
  User,
  RefreshToken,
  EmailVerification,
  PasswordReset,
  PhoneVerification,
  Household,
  HouseholdMember,
  HouseholdActionRequest,
  Invitation,
  FeedPost,
  FeedLike,
  FeedComment,
  CommentReaction,
  FeedMedia,
  PostTag,
  Conversation,
  ConversationParticipant,
  Task,
  TaskAssignee,
  GroceryItem,
  TodoItem,
  Expense,
  ExpenseParticipant,
  Settlement,
  VaultDocument,
  VaultKey,
  VaultDocumentKey,
  ChatMessage,
  ChatReaction,
  CheckIn,
  PingRequest,
  SavedPlace,
  CalendarEvent,
  CalendarSyncState,
  EventInvitee,
  NotificationPreference,
  NotificationHistory,
  DeviceToken,
  JournalEntry,
  JournalMedia,
  BillingCustomer,
  BillingSubscription,
  BillingCheckoutSession,
  BillingEvent,
  BillingTransaction,
  BillingRoutingRule,
  BillingPriceNotice,
  BillingReconciliationRun,
  BillingReconciliationItem,
  AdminAuditLog,
};

export default models;
