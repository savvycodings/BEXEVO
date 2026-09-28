# Why the earlier correction video looked better

This note is for the Fun Control change in `c22145d` ("Draw a standard OpenPose skeleton for Fun Control and stop asking for the ball"). That commit did not swap the model. The weak clips were a different pipeline.

## What actually rendered

| | Earlier clip | The weak clips |
|---|---|---|
| Analysis | `0b7a910c-f15d-491f-b67c-8c3d302245c0` | `e53e733d-fd72-447a-b68b-decc5dacda8e` (Backhand return lob), `cd1b5442-af4b-49ec-834d-ad2dc6dcc4f4` (Forehand return lob) |
| Pipeline | Fun Control | TI2V image-to-video (`branch=ti2v-i2v`) |
| Workflow | `video_wan2_2_fun_control.api.json` | `video_wan2_2_5B_ti2v.json` |
| Weights | Wan 2.2 Fun Control 14B, both noise experts | `wan2.2_ti2v_5B_fp16.safetensors` |
| Pose clip | OpenPose control video | none (`poseVideo: null`) |
| Sampling | 20 steps, 768-pixel canvas, 33 frames at 16 fps | 8 steps, 832×480, 17 frames (about 0.7 s at 24 fps) |
| File | about 1.5 MB, a few minutes | about 110 KB, 8–19 seconds |

`c22145d` does not edit `workflows/video_wan2_2_fun_control.api.json` or the installed weights. The 14B Fun Control models and `wan_2.1_vae.safetensors` were already on disk. The 5B weights were added later only so the backup could run.

## Why those two clips left Fun Control

The pro library has embedded clips for `backhand_volley`, `forehand_volley`, and `bandeja` only. There is no `save_return` clip and no `backhand_return_with_lob` clip. Fun Control needs `neighbors[0]` as the skeleton. With no match, the server sent the 5B image-to-video workflow instead. That path only sees the player's frame and the shot name. It does not follow a pro pose.

The return-lob videos never executed the OpenPose drawing or the "no ball" prompt. Those run only inside Fun Control.

## What `c22145d` did change on the Fun Control path

On a clip that does have a pro pose, that commit:

- Replaced the prompt's "exactly one ball, make contact with that ball" with "No ball in the scene."
- Stopped painting the YOLO ball disk on the control clip (`CORRECTION_DRAW_BALL` defaulted off).
- Redrew the stick figure as OpenPose-18 (neck point, limbs blended at 0.6) instead of the previous bone list and white joints.

Resolution, step count, frame count, and the workflow file stayed the same. The look change on a real Fun Control render is the missing ball and the different skeleton, not a smaller model.

## What we are running now

Generate Video stays on Fun Control: 14B, pose control, 768 canvas, 33 frames, 20 steps. The prompt again asks for one ball and contact with it, and the control clip paints that ball marker with the previous limb drawing.

When the declared stroke has no embedded clip, retrieval still keeps that shot name and uses the closest completed pro clip as the skeleton. It logs `exact stroke missing; using closest pro clip`. It does not send the 5B workflow. A cached TI2V result is not served, so Generate Video can be run again on those analyses.
