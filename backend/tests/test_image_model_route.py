import app as studio_app


def make_generator(tmp_path, model, api_url="https://subimg.jmlt.asia", provider_protocol=""):
    gen = studio_app.ImageGenerator()
    assert gen.initialize(
        api_key="sk-test",
        api_url=api_url,
        output_dir=str(tmp_path),
        model=model,
        provider_protocol=provider_protocol,
    )
    return gen


def test_gpt_image_model_uses_async_images_when_provider_is_async(tmp_path):
    gen = make_generator(
        tmp_path,
        model="gpt-image-2",
        provider_protocol="openai_images_async",
    )

    assert gen.use_openai_images_async is True
    assert gen.use_openai_images is False
    assert gen.use_chat_image is False


def test_chat_image_model_overrides_async_provider_protocol(tmp_path):
    gen = make_generator(
        tmp_path,
        model="gpt-5.4-mini",
        provider_protocol="openai_images_async",
    )

    assert gen.use_chat_image is True
    assert gen.use_openai_images_async is False
    assert gen.use_openai_images is False


def test_gpt_image_model_without_async_protocol_uses_images_api(tmp_path):
    gen = make_generator(tmp_path, model="gpt-image-1.5")

    assert gen.use_openai_images is True
    assert gen.use_openai_images_async is False
    assert gen.use_chat_image is False


def test_chat_image_model_overrides_local_proxy_route(tmp_path):
    gen = make_generator(
        tmp_path,
        model="gpt-5.5",
        api_url="http://127.0.0.1:8045",
    )

    assert gen.use_chat_image is True
    assert gen.use_openai is False
