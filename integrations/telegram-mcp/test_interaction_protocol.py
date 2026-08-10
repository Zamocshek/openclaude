import json
import unittest

from interaction_protocol import format_agent_interaction_envelope


class InteractionProtocolTests(unittest.TestCase):
    def test_builds_generic_bounded_envelope(self):
        envelope = format_agent_interaction_envelope(
            interaction_id="device:select-1",
            handler="android.select-device",
            stage="device",
            prompt="Choose a device.",
            input_name="device",
            input_kind="choice",
            input_prompt="Choose a device.",
            choices=["phone", "tablet"],
            state={"requestId": "req-1"},
        )
        raw = envelope.removeprefix("<openclaude_interaction>").removesuffix(
            "</openclaude_interaction>"
        )
        payload = json.loads(raw)
        self.assertEqual(payload["protocol"], "openclaude.interaction/v1")
        self.assertEqual(payload["handler"], "android.select-device")
        self.assertEqual(payload["input"]["choices"], ["phone", "tablet"])

    def test_rejects_secret_state(self):
        with self.assertRaises(ValueError):
            format_agent_interaction_envelope(
                interaction_id="auth:1",
                handler="service.authorize",
                stage="secret",
                prompt="Enter secret.",
                input_name="secret",
                input_kind="secret",
                input_prompt="Enter secret.",
                state={"password": "must-not-persist"},
            )


if __name__ == "__main__":
    unittest.main()
