from app.deduplication import FinalDeduplicator


def test_same_session_and_segment_is_accepted_once() -> None:
    deduplicator = FinalDeduplicator()
    assert deduplicator.accept("session-a", "3") is True
    assert deduplicator.accept("session-a", "3") is False


def test_same_segment_number_in_new_session_is_distinct() -> None:
    deduplicator = FinalDeduplicator()
    assert deduplicator.accept("session-a", "1") is True
    assert deduplicator.accept("session-b", "1") is True


def test_old_entries_are_evicted_at_capacity() -> None:
    deduplicator = FinalDeduplicator(capacity=2)
    assert deduplicator.accept("s", "1") is True
    assert deduplicator.accept("s", "2") is True
    assert deduplicator.accept("s", "3") is True
    assert deduplicator.accept("s", "1") is True

