"""Test camera user and password cleanup."""

import unittest

from frigate.util.builtin import (
    clean_camera_user_pass,
    escape_special_characters,
    redact_url_secrets,
)


class TestUserPassCleanup(unittest.TestCase):
    def setUp(self) -> None:
        self.rtsp_with_pass = "rtsp://user:password@192.168.0.2:554/live"
        self.rtsp_with_special_pass = "rtsp://user:password`~!@#$%^&*()-_;',.<>:\"\\{\\}\\[\\]@@192.168.0.2:554/live"
        self.rtsp_no_pass = "rtsp://192.168.0.3:554/live"

    def test_cleanup(self):
        """Test that user / pass are cleaned up."""
        clean = clean_camera_user_pass(self.rtsp_with_pass)
        assert clean != self.rtsp_with_pass
        assert "user:password" not in clean

    def test_no_cleanup(self):
        """Test that nothing changes when no user / pass are defined."""
        clean = clean_camera_user_pass(self.rtsp_no_pass)
        assert clean == self.rtsp_no_pass

    def test_special_char_password(self):
        """Test that special characters in pw are escaped, but not others."""
        escaped = escape_special_characters(self.rtsp_with_special_pass)
        assert (
            escaped
            == "rtsp://user:password%60~%21%40%23%24%25%5E%26%2A%28%29-_%3B%27%2C.%3C%3E%3A%22%5C%7B%5C%7D%5C%5B%5C%5D%40@192.168.0.2:554/live"
        )

    def test_no_special_char_password(self):
        """Test that no change is made to path with no special characters."""
        escaped = escape_special_characters(self.rtsp_with_pass)
        assert escaped == self.rtsp_with_pass


class TestUserPassMasking(unittest.TestCase):
    def setUp(self) -> None:
        self.rtsp_log_message = "Did you mean file:rtsp://user:password@192.168.1.3:554"

    def test_rtsp_in_log_message(self):
        """Test that the rtsp url in a log message is escaped."""
        escaped = clean_camera_user_pass(self.rtsp_log_message)
        print(f"The escaped is {escaped}")
        assert escaped == "Did you mean file:rtsp://*:*@192.168.1.3:554"


class TestUserPassMaskingUserNames(unittest.TestCase):
    """Masked text reaches camera viewers through the stats, not only admins."""

    def test_user_names_outside_the_escaping_pattern(self):
        for user in ("cam.user", "user%40site", "first+last", "user~1"):
            with self.subTest(user=user):
                line = f"rtsp://{user}:secret@192.0.2.1:554/live: 401 Unauthorized"
                assert (
                    clean_camera_user_pass(line)
                    == "rtsp://*:*@192.0.2.1:554/live: 401 Unauthorized"
                )

    def test_password_with_at_signs_and_a_dotted_user(self):
        masked = clean_camera_user_pass(
            "[tcp @ 0x55] rtsp://cam.user:p@ss@word@192.0.2.1/live"
        )
        assert masked == "[tcp @ 0x55] rtsp://*:*@192.0.2.1/live"

    def test_urls_separated_by_a_comma_stay_separate(self):
        # the ffprobe API splits on a comma left in the masked paths
        assert (
            clean_camera_user_pass(
                "rtsp://cam.one:p@ss,1@192.0.2.1/live,rtsp://cam.two:pw@192.0.2.2/live"
            )
            == "rtsp://*:*@192.0.2.1/live,rtsp://*:*@192.0.2.2/live"
        )

    def test_at_signs_after_the_host_are_not_masked(self):
        assert (
            clean_camera_user_pass("rtsp://cam:p@ss@192.0.2.1/live?tag=a@b failed")
            == "rtsp://*:*@192.0.2.1/live?tag=a@b failed"
        )

    def test_a_port_is_not_taken_for_a_password(self):
        line = "rtsp://192.0.2.1:554/live?tag=a@b: Connection refused"
        assert clean_camera_user_pass(line) == line

    def test_http_query_with_a_dotted_user(self):
        masked = clean_camera_user_pass(
            "http://192.0.2.1/cgi-bin/snap.cgi?user=cam.user&password=secret"
        )
        assert masked == "http://192.0.2.1/cgi-bin/snap.cgi?user=*&password=*"

    def test_escaping_still_skips_dotted_user_names(self):
        # escaping rewrites the ffmpeg input, so its matches must not grow
        path = "rtsp://cam.user:p@ss@192.0.2.1/live"
        assert escape_special_characters(path) == path


class TestRedactUrlSecrets(unittest.TestCase):
    def test_token_without_user_and_password(self):
        assert (
            redact_url_secrets("http://192.0.2.1/live?token=secret: 403 Forbidden")
            == "http://192.0.2.1/live?token=*: 403 Forbidden"
        )

    def test_every_query_value_and_the_credentials(self):
        assert (
            redact_url_secrets(
                "rtsp://cam.user:pw@192.0.2.1/live?channel=1&key=abc#frag failed"
            )
            == "rtsp://*:*@192.0.2.1/live?channel=*&key=*#frag failed"
        )

    def test_ffmpeg_tcp_error(self):
        assert redact_url_secrets(
            "[tcp @ 0x55] Connection to tcp://192.0.2.1:554?timeout=10000000 "
            "failed: No route to host"
        ) == (
            "[tcp @ 0x55] Connection to tcp://192.0.2.1:554?timeout=* "
            "failed: No route to host"
        )

    def test_text_without_urls_is_unchanged(self):
        line = "Error opening output files: Invalid argument (a=1&b=2)"
        assert redact_url_secrets(line) == line
