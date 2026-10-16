import unittest
from unittest.mock import patch

from frigate.config import FrigateConfig
from frigate.config.camera.ffmpeg import FFMPEG_INPUT_ARGS_DEFAULT
from frigate.ffmpeg_presets import (
    _gpu_selector,
    parse_preset_hardware_acceleration_decode,
    parse_preset_hardware_acceleration_encode,
    parse_preset_input,
)


class TestFfmpegPresets(unittest.TestCase):
    def setUp(self):
        self.default_ffmpeg = {
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "back": {
                    "ffmpeg": {
                        "inputs": [
                            {
                                "path": "rtsp://10.0.0.1:554/video",
                                "roles": ["detect"],
                            }
                        ],
                        "output_args": {
                            "detect": "-f rawvideo -pix_fmt yuv420p",
                            "record": "-f segment -segment_time 10 -segment_format mp4 -reset_timestamps 1 -strftime 1 -c copy -an",
                        },
                    },
                    "detect": {
                        "height": 1080,
                        "width": 1920,
                        "fps": 5,
                    },
                    "record": {
                        "enabled": True,
                    },
                    "name": "back",
                }
            },
        }

    def test_default_ffmpeg(self):
        FrigateConfig(**self.default_ffmpeg)

    def test_ffmpeg_hwaccel_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["hwaccel_args"] = (
            "preset-rpi-64-h264"
        )
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "preset-rpi-64-h264" not in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )
        assert "-c:v:1 h264_v4l2m2m" in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )

    def test_ffmpeg_hwaccel_apple_preset_decodes_every_stream(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["hwaccel_args"] = (
            "preset-apple-silicon-h265"
        )
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        cmd = " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        assert "-c:v hevc_v4l2m2m" in cmd
        assert "-c:v:1" not in cmd
        assert "scale=1920:1080" in cmd

    def test_ffmpeg_hwaccel_not_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["hwaccel_args"] = (
            "-other-hwaccel args"
        )
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "-other-hwaccel args" in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )

    def test_ffmpeg_hwaccel_scale_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["hwaccel_args"] = (
            "preset-nvidia-h264"
        )
        self.default_ffmpeg["cameras"]["back"]["detect"] = {
            "height": 1920,
            "width": 2560,
            "fps": 10,
        }
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "preset-nvidia-h264" not in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )
        assert "fps=10,scale_cuda=w=2560:h=1920,hwdownload,format=nv12" in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )

    def test_default_ffmpeg_input_arg_preset(self):
        frigate_config = FrigateConfig(**self.default_ffmpeg)

        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["input_args"] = (
            "preset-rtsp-generic"
        )
        frigate_preset_config = FrigateConfig(**self.default_ffmpeg)
        assert (
            # Ignore global and user_agent args in comparison
            frigate_preset_config.cameras["back"].ffmpeg_cmds[0]["cmd"]
            == frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"]
        )

    def test_ffmpeg_input_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["input_args"] = (
            "preset-rtmp-generic"
        )
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "preset-rtmp-generic" not in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )
        assert (" ".join(parse_preset_input("preset-rtmp-generic", 5))) in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )

    def test_ffmpeg_input_args_as_string(self):
        # Strip user_agent args here to avoid handling quoting issues
        defaultArgsList = parse_preset_input(FFMPEG_INPUT_ARGS_DEFAULT, 5)[2::]
        argsString = " ".join(defaultArgsList) + ' -some "arg with space"'
        argsList = defaultArgsList + ["-some", "arg with space"]
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["input_args"] = argsString
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert set(argsList).issubset(
            frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"]
        )

    def test_ffmpeg_input_not_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["input_args"] = "-some inputs"
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "-some inputs" in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )

    def test_ffmpeg_output_record_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["output_args"]["record"] = (
            "preset-record-generic-audio-aac"
        )
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "preset-record-generic-audio-aac" not in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )
        assert "-c:v copy -c:a aac" in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )

    def test_ffmpeg_output_record_not_preset(self):
        self.default_ffmpeg["cameras"]["back"]["ffmpeg"]["output_args"]["record"] = (
            "-some output -segment_time 10"
        )
        frigate_config = FrigateConfig(**self.default_ffmpeg)
        assert "-some output" in (
            " ".join(frigate_config.cameras["back"].ffmpeg_cmds[0]["cmd"])
        )


class TestGpuDevicePresets(unittest.TestCase):
    def use_gpus(self, gpus: list[str]) -> None:
        # the selector caches what it found in /dev/dri and logs a missing GPU
        # once per process
        for attribute, value in (
            ("_valid_gpus", gpus),
            ("_missing_gpu_logged", False),
        ):
            patcher = patch.object(_gpu_selector, attribute, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def detect_cmd(self, hwaccel_args: str) -> str:
        config = FrigateConfig(
            **{
                "mqtt": {"host": "mqtt"},
                "cameras": {
                    "back": {
                        "ffmpeg": {
                            "hwaccel_args": hwaccel_args,
                            "inputs": [
                                {
                                    "path": "rtsp://10.0.0.1:554/video",
                                    "roles": ["detect"],
                                }
                            ],
                        },
                        "detect": {"height": 720, "width": 1280, "fps": 5},
                    }
                },
            }
        )
        return " ".join(config.cameras["back"].ffmpeg_cmds[0]["cmd"])

    def test_vaapi_without_gpu_drops_the_device_option(self):
        self.use_gpus([])

        with self.assertLogs("frigate.ffmpeg_presets", "ERROR") as logs:
            cmd = self.detect_cmd("preset-vaapi")

        # an empty device made ffmpeg read -hwaccel_output_format as the device
        # and vaapi as an output file
        assert "-hwaccel_device" not in cmd
        assert "-hwaccel vaapi -hwaccel_output_format vaapi" in cmd
        assert "No usable GPU was found in /dev/dri" in logs.output[0]

    def test_vaapi_with_gpu_keeps_the_device(self):
        self.use_gpus(["/dev/dri/renderD129"])

        with self.assertNoLogs("frigate.ffmpeg_presets", "ERROR"):
            cmd = self.detect_cmd("preset-vaapi")

        assert "-hwaccel_device /dev/dri/renderD129 -hwaccel_output_format vaapi" in cmd

    def test_qsv_without_gpu_drops_the_device_option(self):
        self.use_gpus([])

        with self.assertLogs("frigate.ffmpeg_presets", "ERROR"):
            args = parse_preset_hardware_acceleration_decode(
                "preset-intel-qsv-h264", 5, 1280, 720, 0
            )

        assert "-qsv_device" not in args
        assert "" not in args
        assert " ".join(args).startswith("-hwaccel qsv -hwaccel_output_format qsv")

    def test_missing_gpu_is_logged_once(self):
        self.use_gpus([])

        with self.assertLogs("frigate.ffmpeg_presets", "ERROR") as logs:
            for _ in range(3):
                parse_preset_hardware_acceleration_decode(
                    "preset-vaapi", 5, 1280, 720, 0
                )

        assert len(logs.records) == 1

    def test_encode_without_gpu_drops_the_device_options(self):
        self.use_gpus([])

        with self.assertLogs("frigate.ffmpeg_presets", "ERROR"):
            cmd = parse_preset_hardware_acceleration_encode(
                "ffmpeg", "preset-vaapi", "-i input", "output"
            )

        assert "-vaapi_device" not in cmd
        assert "-hwaccel_device" not in cmd
        assert cmd.startswith(
            "ffmpeg -hide_banner -hwaccel vaapi -hwaccel_output_format vaapi "
            "-i input -c:v h264_vaapi"
        )

    def test_presets_without_a_device_do_not_look_for_a_gpu(self):
        self.use_gpus([])

        with (
            patch.object(_gpu_selector, "get_gpu_arg") as get_gpu_arg,
            self.assertNoLogs("frigate.ffmpeg_presets", "ERROR"),
        ):
            parse_preset_hardware_acceleration_encode(
                "ffmpeg", "default", "-i input", "output"
            )
            parse_preset_hardware_acceleration_decode(
                "preset-rpi-64-h264", 5, 1280, 720, 0
            )

        get_gpu_arg.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
