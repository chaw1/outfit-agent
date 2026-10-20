from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session

from app.models import Base, Job, Project, User, utcnow
from app.worker import claim_job


@pytest.mark.integration
def test_worker_claim_skips_another_transactions_locked_job(isolated_database_url):
    engine = create_engine(isolated_database_url)
    try:
        Base.metadata.create_all(engine)
        with Session(engine, expire_on_commit=False) as setup:
            user = User(username=f"queue_{uuid4().hex[:16]}", password_hash="unused",
                        nickname="队列")
            setup.add(user)
            setup.flush()
            project = Project(user_id=user.id, title="队列争抢", brand="测试", brief="测试")
            setup.add(project)
            setup.flush()
            first = Job(project_id=project.id, user_id=user.id, kind="image",
                        available_at=utcnow() - timedelta(seconds=20), dedupe_key=str(uuid4()))
            second = Job(project_id=project.id, user_id=user.id, kind="image",
                         available_at=utcnow() - timedelta(seconds=10), dedupe_key=str(uuid4()))
            setup.add_all([first, second])
            setup.commit()
            first_id, second_id = first.id, second.id
        with Session(engine) as lock_owner, Session(engine) as claimant:
            lock_owner.scalar(select(Job).where(Job.id == first_id).with_for_update())
            claimant.execute(text("SET LOCAL lock_timeout = '2s'"))
            claimed = claim_job(claimant)
            assert claimed.id == second_id
            assert claimed.status == "running" and claimed.attempts == 1
            assert lock_owner.get(Job, first_id).status == "queued"
            lock_owner.rollback()
        with Session(engine) as remaining:
            claimed = claim_job(remaining)
            assert claimed.id == first_id and claimed.attempts == 1
    finally:
        engine.dispose()
