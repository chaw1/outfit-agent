from datetime import UTC, datetime, timedelta

from langchain_core.messages import AIMessage, HumanMessage
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.main import restore_messages
from app.models import Base, Message, Project, User


def test_display_history_recovers_from_checkpoint_after_business_rollback():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    timestamp = datetime.now(UTC)
    card = {"id": "stable-script", "type": "script", "status": "draft", "shots": []}
    state = {
        "messages": [
            HumanMessage(
                id="turn-1:user",
                content='{"type":"choose_direction"}',
                additional_kwargs={
                    "display": {
                        "text": "",
                        "cards": [],
                        "action": {"type": "choose_direction"},
                        "created_at": timestamp.isoformat(),
                    }
                },
            ),
            AIMessage(
                id="turn-1:assistant",
                content="脚本写好了",
                additional_kwargs={
                    "display": {
                        "text": "脚本写好了",
                        "cards": [card],
                        "action": None,
                        "created_at": (timestamp + timedelta(microseconds=1)).isoformat(),
                    }
                },
            ),
        ]
    }
    with Session(engine) as session:
        user = User(username="restore", password_hash="unused", nickname="恢复")
        session.add(user)
        session.flush()
        project = Project(user_id=user.id, title="恢复", brand="示例", brief="夏季")
        session.add(project)
        session.commit()
        # A committed checkpoint survives a rolled-back business projection.
        first_id = restore_messages(session, project.id, state)
        session.rollback()
        assert not session.scalars(select(Message)).all()
        assert restore_messages(session, project.id, state) == first_id
        session.commit()
        assert restore_messages(session, project.id, state) == first_id
        session.commit()
        messages = session.scalars(select(Message).order_by(Message.created_at)).all()
        assert len(messages) == 2
        assert messages[0].role == "user" and messages[0].text == ""
        assert messages[0].action == {"type": "choose_direction"}
        assert messages[1].id == first_id and messages[1].cards == [card]
        assert messages[1].text == "脚本写好了"
    engine.dispose()
