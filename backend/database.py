import os
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    create_engine,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship, sessionmaker
from sqlalchemy.pool import QueuePool

# Get database URL from environment variable
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./speedchat.db")

# Fix for Fly.io postgres:// URLs (SQLAlchemy 2.0+ requires postgresql://)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Create SQLAlchemy engine with connection pooling
engine = create_engine(
    DATABASE_URL,
    poolclass=QueuePool,
    pool_size=10,  # Number of connections to maintain
    max_overflow=20,  # Additional connections that can be created
    pool_pre_ping=True,  # Verify connections before use
    pool_recycle=3600,  # Recycle connections after 1 hour
    echo=False,  # Set to True for SQL debugging
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Config(Base):
    __tablename__ = "config"

    id = Column(Integer, primary_key=True, index=True)
    session_duration = Column(String, default="30")
    alarm_interval = Column(String, default="5")
    max_people_per_line = Column(String, default="10")
    blink_before_start = Column(Boolean, default=False)
    blink_time = Column(String, default="5")
    finish_window = Column(String, default="5")
    auto_reschedule = Column(String, default="off")


class Line(Base):
    __tablename__ = "lines"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    time = Column(String)
    people = relationship("Person", back_populates="line", cascade="all, delete-orphan")


class Person(Base):
    __tablename__ = "people"

    id = Column(Integer, primary_key=True, index=True)
    line_id = Column(Integer, ForeignKey("lines.id", ondelete="CASCADE"))
    name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    line = relationship("Line", back_populates="people")


class GeneralWaitQueue(Base):
    __tablename__ = "general_wait_queue"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)


class WaitQueuePerson(Base):
    __tablename__ = "wait_queue_people"

    id = Column(Integer, primary_key=True, index=True)
    line_id = Column(
        Integer, ForeignKey("lines.id", ondelete="CASCADE", onupdate="CASCADE")
    )
    name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)


# Create all tables
def init_db():
    Base.metadata.create_all(bind=engine)


# Database dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
