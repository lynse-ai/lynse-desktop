---
name: Bug 报告
about: 报告一个可复现的问题
title: "[Bug] "
labels: bug
body:
  - type: textarea
    id: description
    attributes:
      label: 问题描述
      description: 清晰简洁地描述问题
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: 复现步骤
      description: 一步步说明如何触发
      placeholder: |
        1. 打开 ...
        2. 点击 ...
        3. 看到 ...
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: 期望行为
      description: 你预期应该发生什么
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: 日志 / 截图
      description: 如有报错信息或截图请附上
  - type: input
    id: version
    attributes:
      label: 应用版本
      placeholder: "例如 0.1.23"
    validations:
      required: true
  - type: dropdown
    id: platform
    attributes:
      label: 平台
      options:
        - macOS (Apple Silicon)
        - macOS (Intel)
        - Windows
        - 其他
    validations:
      required: true
