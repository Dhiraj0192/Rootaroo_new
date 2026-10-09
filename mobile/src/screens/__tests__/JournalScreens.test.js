import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockRepo = {
  loadEntry: jest.fn(),
  onThisDayView: jest.fn(async () => []),
  monthView: jest.fn(),
  loadPhoto: jest.fn(),
  discardPhotos: jest.fn(async () => {}),
};
jest.mock('../../shared/journal/journalRepo', () => ({
  getJournalRepo: () => mockRepo,
  isKeyMissing: () => false,
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('../../shared/permissions', () => ({ ensureCamera: jest.fn() }));
jest.mock('../../shared/api/journal', () => ({ journalApi: { delete: jest.fn() } }));
jest.mock('@react-navigation/native', () => ({ useFocusEffect: (cb) => require('react').useEffect(cb, []) }));
jest.mock('../../shared/hooks/useTabBarDockHeight', () => ({ useTabBarDockHeight: () => 0 }));

const JournalEntryDetailScreen = require('../JournalEntryDetailScreen').default;
const JournalEntryEditorScreen = require('../JournalEntryEditorScreen').default;
const JournalHistoryScreen = require('../JournalHistoryScreen').default;

const navigation = { goBack: jest.fn(), navigate: jest.fn(), push: jest.fn() };

describe('JournalEntryDetailScreen', () => {
  it('shows decrypted text and word count', async () => {
    mockRepo.loadEntry.mockResolvedValue({
      id: 'e1', createdAt: '2026-10-05T10:00:00Z', text: 'one two three', mood: null, tags: ['a'], media: [], unreadable: false,
    });
    const { findByText, getByText } = render(<JournalEntryDetailScreen navigation={navigation} route={{ params: { entryId: 'e1' } }} />);
    expect(await findByText('one two three', {}, { timeout: 5000 })).toBeTruthy();
    expect(getByText(/3 words/)).toBeTruthy();
    expect(getByText('Edit entry')).toBeTruthy();
  });

  it('opens the editor with the entry id only, never the decrypted text or key', async () => {
    const entry = {
      id: 'e1', createdAt: '2026-10-05T10:00:00Z', text: 'secret words', mood: null, tags: [], media: [], unreadable: false,
    };
    Object.defineProperty(entry, 'entryKey', { value: new Uint8Array(32), enumerable: false });
    mockRepo.loadEntry.mockResolvedValue(entry);
    navigation.navigate.mockClear();
    const { findByText } = render(<JournalEntryDetailScreen navigation={navigation} route={{ params: { entryId: 'e1' } }} />);
    fireEvent.press(await findByText('Edit entry'));
    expect(navigation.navigate).toHaveBeenCalledWith('JournalEditor', { entryId: 'e1' });
    expect(JSON.stringify(navigation.navigate.mock.calls)).not.toContain('secret words');
  });

  it('shows an unreadable entry without an edit button', async () => {
    mockRepo.loadEntry.mockResolvedValue({
      id: 'e2', createdAt: '2026-10-05T10:00:00Z', text: "Can't open this entry", mood: null, tags: [], media: [], unreadable: true,
    });
    const { findByText, queryByText } = render(<JournalEntryDetailScreen navigation={navigation} route={{ params: { entryId: 'e2' } }} />);
    expect(await findByText("Can't open this entry")).toBeTruthy();
    expect(queryByText('Edit entry')).toBeNull();
  });
});

describe('JournalHistoryScreen', () => {
  it('builds the mood summary and top tags from the phone-side month view', async () => {
    mockRepo.monthView.mockResolvedValue({
      month: '2026-10', entryDates: ['2026-10-05'], daysInMonth: 31, firstWeekday: 3,
      moodDays: { '2026-10-05': 'happy' }, topTags: [{ tag: 'family', count: 2 }], moodSummary: 'happy', goodDays: 1,
    });
    const { findByText } = render(<JournalHistoryScreen navigation={navigation} />);
    expect(await findByText('family · 2')).toBeTruthy();
    await waitFor(() => expect(mockRepo.monthView).toHaveBeenCalled());
  });
});

describe('JournalEntryEditorScreen', () => {
  it('loads the entry to edit from the repo by id', async () => {
    mockRepo.loadEntry.mockResolvedValue({
      id: 'e1', createdAt: '2026-10-05T10:00:00Z', text: 'loaded by id', mood: null, tags: [], media: [], unreadable: false,
    });
    const { findByDisplayValue } = render(<JournalEntryEditorScreen navigation={navigation} route={{ params: { entryId: 'e1' } }} />);
    expect(await findByDisplayValue('loaded by id')).toBeTruthy();
    expect(mockRepo.loadEntry).toHaveBeenCalledWith('e1');
  });

  it('cleans up plain picker copies when the screen goes away', async () => {
    mockRepo.discardPhotos.mockClear();
    const { unmount } = render(<JournalEntryEditorScreen navigation={navigation} route={{ params: {} }} />);
    unmount();
    expect(mockRepo.discardPhotos).toHaveBeenCalledWith([]);
  });
});
