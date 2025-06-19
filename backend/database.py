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

# Get database URL from environment variable
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./speedchat.db")

# Fix for Fly.io postgres:// URLs (SQLAlchemy 2.0+ requires postgresql://)
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Create SQLAlchemy engine
engine = create_engine(DATABASE_URL)
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
    line_id = Column(Integer, ForeignKey("lines.id"))
    name = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    line = relationship("Line", back_populates="people")


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
