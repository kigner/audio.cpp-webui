import pytest

from app.state import DictationState, InvalidStateTransition, StateMachine


def test_happy_path_state_machine() -> None:
    machine = StateMachine()
    assert machine.state == DictationState.IDLE
    machine.transition(DictationState.CONNECTING)
    machine.transition(DictationState.LISTENING)
    machine.transition(DictationState.FINALIZING)
    machine.transition(DictationState.IDLE)
    assert machine.state == DictationState.IDLE


def test_error_can_retry() -> None:
    machine = StateMachine()
    machine.transition(DictationState.ERROR)
    machine.transition(DictationState.CONNECTING)
    assert machine.state == DictationState.CONNECTING


def test_invalid_transition_is_rejected() -> None:
    machine = StateMachine()
    with pytest.raises(InvalidStateTransition):
        machine.transition(DictationState.FINALIZING)

