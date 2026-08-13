import content_workflow as cw


def _connect(tmp_path, monkeypatch):
    db_file = tmp_path / "content.sqlite3"
    monkeypatch.setenv("TELEGRAM_MCP_CONTENT_DB", str(db_file))
    return cw.connect()


def test_config_channels_and_stats(tmp_path, monkeypatch):
    with _connect(tmp_path, monkeypatch) as conn:
        config = cw.set_config(
            conn,
            research_account_id="research-main",
            similarity_threshold=0.91,
        )
        source = cw.upsert_channel(
            conn,
            kind="source",
            account_id="research-main",
            chat_id="-1001",
            title="Source",
            username="source_channel",
        )
        target = cw.upsert_channel(
            conn,
            kind="target",
            account_id="publisher",
            chat_id="-1002",
            title="Target",
        )
        conn.commit()

        assert config["research_account_id"] == "research-main"
        assert config["similarity_threshold"] == 0.91
        assert source["kind"] == "source"
        assert target["kind"] == "target"
        assert len(cw.list_channels(conn, enabled_only=True)) == 2
        assert cw.stats(conn)["database"].endswith("content.sqlite3")


def test_similarity_blocks_near_duplicate_draft(tmp_path, monkeypatch):
    with _connect(tmp_path, monkeypatch) as conn:
        cw.store_post(
            conn,
            role="published",
            account_id="publisher",
            chat_id="-1002",
            text=(
                "Remote work hiring funnel: screen leads, qualify chats, "
                "and publish a daily report."
            ),
        )
        conn.commit()

        result = cw.create_draft(
            conn,
            text=(
                "Remote work hiring funnel screen leads qualify chats " "and publish daily reports"
            ),
            target_chat_id="-1002",
            target_account_id="publisher",
            threshold=0.8,
        )

        assert result["ok"] is False
        assert result["blocked"] is True
        assert result["similar"][0]["role"] == "published"


def test_unique_draft_and_publish_marker(tmp_path, monkeypatch):
    with _connect(tmp_path, monkeypatch) as conn:
        source = cw.store_post(
            conn,
            role="source",
            status="synced",
            account_id="research-main",
            chat_id="-1001",
            message_id=10,
            chat_title="Source",
            text="Five hooks for a product launch thread.",
        )
        draft_result = cw.create_draft(
            conn,
            text="Launch note: open with the user pain, then show the proof and the offer.",
            target_chat_id="-1002",
            target_account_id="publisher",
            source_post_id=source["id"],
        )
        assert draft_result["ok"] is True
        draft_id = draft_result["draft"]["id"]

        published = cw.mark_draft_published(
            conn,
            draft_id=draft_id,
            account_id="publisher",
            chat_id="-1002",
            chat_title="Target",
            message_id=99,
            message_date="2026-06-24T10:00:00+00:00",
        )
        conn.commit()

        draft = cw.get_post(conn, draft_id)
        unused = cw.research_posts(conn, unused_only=True)

        assert published["role"] == "published"
        assert published["message_id"] == 99
        assert draft["status"] == "published"
        assert unused == []


def test_import_history_and_role_filter(tmp_path, monkeypatch):
    with _connect(tmp_path, monkeypatch) as conn:
        imported = cw.import_history(
            conn,
            [
                {"text": "First old post", "chat_id": "-1002"},
                {"text": "Second old post", "role": "draft", "status": "draft"},
            ],
            default_role="published",
            default_account_id="publisher",
        )
        conn.commit()

        published = cw.list_posts(conn, role="published", include_text=True)
        drafts = cw.list_posts(conn, role="draft", include_text=True)

        assert len(imported) == 2
        assert [post["text"] for post in published] == ["First old post"]
        assert [post["text"] for post in drafts] == ["Second old post"]


def test_source_reference_resolves_public_and_private_post_links(tmp_path, monkeypatch):
    with _connect(tmp_path, monkeypatch) as conn:
        cw.upsert_channel(
            conn,
            kind="source",
            account_id="research-main",
            chat_id="-100123456789",
            peer_id="-100123456789",
            title="Donor",
            username="donor_channel",
        )
        source = cw.store_post(
            conn,
            role="source",
            account_id="research-main",
            chat_id="-100123456789",
            peer_id="-100123456789",
            message_id=42,
            text="Rich source",
        )
        conn.commit()

        public = cw.find_source_post_by_reference(conn, "https://t.me/donor_channel/42")
        private = cw.find_source_post_by_reference(conn, "https://t.me/c/123456789/42")

        assert public["id"] == source["id"]
        assert private["id"] == source["id"]


def test_campaign_requires_verified_readback_for_completion(tmp_path, monkeypatch):
    with _connect(tmp_path, monkeypatch) as conn:
        draft = cw.create_draft(
            conn,
            text="A developed post with a durable delivery receipt.",
            target_chat_id="-1002",
            target_account_id="publisher",
        )["draft"]
        campaign = cw.create_campaign(
            conn,
            name="receipt-regression",
            account_id="publisher",
            required_targets=[
                {
                    "profile_id": "target-profile",
                    "name": "Target",
                    "reference": "-1002",
                }
            ],
            excluded_targets=[],
            requested_format="standard",
            min_chars=1,
        )
        cw.assign_campaign_item(
            conn,
            campaign_id=campaign["id"],
            target_profile_id="target-profile",
            draft_id=draft["id"],
            action_id=41,
            expected_peer_id="-1002",
        )
        unverified = cw.record_campaign_delivery(
            conn,
            campaign_id=campaign["id"],
            draft_id=draft["id"],
            action_id=41,
            actual_peer_id="-1002",
            message_id=99,
            verification={"verified": False, "readback_text_matches": False},
        )
        verified = cw.record_campaign_delivery(
            conn,
            campaign_id=campaign["id"],
            draft_id=draft["id"],
            action_id=41,
            actual_peer_id="-1002",
            message_id=99,
            verification={"verified": True, "readback_text_matches": True},
        )
        conn.commit()

        assert unverified["status"] == "sent"
        assert unverified["items"][0]["status"] == "sent"
        assert verified["status"] == "verified"
        assert verified["items"][0]["status"] == "verified"
