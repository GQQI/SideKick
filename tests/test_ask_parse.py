from __future__ import annotations

from metateam.runtime.ask import should_keep_as_markdown, try_parse_inline_ask


def test_keypoints_are_not_inline_ask() -> None:
    text = """下面是几个要点：
1. **架构**：模块边界还是比较清晰，职责拆分合理
2. **性能**：热点路径需要缓存
3. **安全**：对外接口要鉴权
"""
    assert try_parse_inline_ask(text) is None


def test_plan_bold_items_are_not_inline_ask() -> None:
    text = """## 执行计划
1. **编写项目简介**
2. **验证文件生成**
"""
    assert try_parse_inline_ask(text) is None


def test_summary_with_haishi_is_not_inline_ask() -> None:
    text = """项目还是比较复杂，主要如下：
1. 先梳理依赖
2. 再补测试
"""
    assert try_parse_inline_ask(text) is None


def test_real_choice_still_parses() -> None:
    text = """请选择部署方式：
1. Docker
2. 本地安装
3. 只生成配置
"""
    parsed = try_parse_inline_ask(text)
    assert parsed is not None
    assert parsed["options"] == ["Docker", "本地安装", "只生成配置"]


def test_should_keep_keypoints_as_markdown() -> None:
    assert should_keep_as_markdown(
        "主要要点如下",
        ["架构分层说明一段比较长的文字", "性能优化建议也写得很长"],
    )
    assert not should_keep_as_markdown("请选择部署方式", ["Docker", "本地安装"])
