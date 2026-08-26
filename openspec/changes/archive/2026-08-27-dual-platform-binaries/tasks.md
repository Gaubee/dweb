# tasks — dual-platform-binaries

- [x] 1.1 roster 锁换 fs4；libc 依赖移除；本地 darwin 测试绿
- [x] 1.2 secret.rs cfg 放开（hard_link 全平台；权限/fsync_dir 平台分支）；`cargo check --target x86_64-pc-windows-msvc` 通过
- [x] 2.1 瘦身 profile（fat LTO + cg=1 + opt-level=z）+ iroh feature 收窄；实测双二进制尺寸记录
- [x] 3.1 client-sdk loader 双平台选择 + files 白名单 + 平台错误
- [x] 3.2 server-binary 双 exe 选择 + bin 入口
- [x] 4.1 CI windows job（test + build + node 套件 + artifact）；rust-test 加 windows target check
- [x] 5.1 全门禁（本地 darwin 全绿 + CI 双平台绿）+ README 体积实测更新 + 提交推送
