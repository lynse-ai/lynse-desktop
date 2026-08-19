---
name: 功能建议
about: 提议一个新功能或改进
title: "[Feature] "
labels: enhancement
body:
  - type: textarea
    id: problem
    attributes:
      label: 要解决的问题
      description: 这个功能解决什么痛点？当前是怎么绕过的？
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: 期望的方案
      description: 你希望它怎么工作
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: 备选方案
      description: 你考虑过的其他做法
