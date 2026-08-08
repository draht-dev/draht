# Seedance 2.5 adapter boundary

## What is verified

- ByteDance hosts an official product page titled **Seedance 2.5**: <https://seed.bytedance.com/seedance2_5>.
- ByteDance hosts an official blog route titled **One-take creation, flexible referencing: Introducing Seedance 2.5**: <https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5>.
- The analyzed film itself visibly advertises Seedance 2.5, “UP TO 30 SECONDS,” video-to-video examples, and naturalistic acting/skin-lighting capabilities. Those overlays are evidence about the supplied promotional film, not automatically an API contract.

The official pages rendered their content client-side in the analysis environment, so no precise endpoint, model ID, duration enum, resolution enum, reference limits, or authentication scheme was extracted from them.

## Adapter assumptions

An unofficial SDK repository was inspected only to shape a replaceable serializer. It exposed fields/methods resembling:

- `prompt`
- `duration`
- `aspectRatio`
- `resolution`
- `model`
- `imageUrls`
- `extraOptions`
- text-to-video and image-to-video operations
- image/video upload and task polling

These names are **not treated as authoritative ByteDance API fields**. Before a live request, fetch the selected provider's current model list/schema and transform `seedance_adapter_payload` accordingly.

## Recommended continuation strategy

1. Generate 5–10 second chunks for stronger continuity.
2. Export the intended source anchor frame and pass it as an image reference when supported.
3. Put time-coded shot actions in the prompt even if the API has only a single prompt field.
4. Keep provider overrides in `provider.extra_options`; never contaminate the canonical shot schema.
5. Validate the generated first/last frames before requesting the next chunk.
6. Do not request text/logos/watermarks in the generated picture; add controlled typography in post-production if needed.

## Credential boundary

The compiler performs no network request. If a future provider client is added:

- read its key from a protected runtime environment variable;
- never serialize it into specs or payload artifacts;
- never pass it in argv;
- never log headers or exception bodies that may contain credentials;
- obtain explicit approval before spending credits or uploading reference media.
