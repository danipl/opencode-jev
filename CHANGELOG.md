# Changelog

## [1.2.0](https://github.com/danipl/opencode-jev/compare/v1.1.0...v1.2.0) (2026-10-05)


### Features

* log note line when the tool list exceeds the criteria cap ([#25](https://github.com/danipl/opencode-jev/issues/25)) ([81f8fae](https://github.com/danipl/opencode-jev/commit/81f8faecdc918899102c10bdc479cd34de51a1f2))
* make timeoutMs file-configurable like every other knob ([#24](https://github.com/danipl/opencode-jev/issues/24)) ([038195f](https://github.com/danipl/opencode-jev/commit/038195f0c37c866df5475ce8764b57dc27ed3c04)), closes [#10](https://github.com/danipl/opencode-jev/issues/10)
* skip the Jev round-trip when the lone candidate tool makes any trim a no-op ([#22](https://github.com/danipl/opencode-jev/issues/22)) ([90994a9](https://github.com/danipl/opencode-jev/commit/90994a964d61f42f775699fa794d366f8bd35fb1))


### Bug Fixes

* preserve Responses-API built-ins through the trim ([#26](https://github.com/danipl/opencode-jev/issues/26)) ([56b944c](https://github.com/danipl/opencode-jev/commit/56b944c5dac8d4e16e2f3ecb1421c3d2c1b9819b))

## [1.1.0](https://github.com/danipl/opencode-jev/compare/v1.0.0...v1.1.0) (2026-10-04)


### Features

* add grilling workflow skill at .agents/skills/grilling ([#19](https://github.com/danipl/opencode-jev/issues/19)) ([f7b998d](https://github.com/danipl/opencode-jev/commit/f7b998dc1c728004b2692750c2f0ea939e9fc005))
* add issue-resolver skill ([#18](https://github.com/danipl/opencode-jev/issues/18)) ([b2075ef](https://github.com/danipl/opencode-jev/commit/b2075ef1b342b7dd40928eaf4e2d6bf9d213ba06)), closes [#15](https://github.com/danipl/opencode-jev/issues/15)
* stamp published version into README via release-please extra-files ([#16](https://github.com/danipl/opencode-jev/issues/16)) ([83e276c](https://github.com/danipl/opencode-jev/commit/83e276c3d6185ce6635ca926832bdeb0ea5f69e3))


### Bug Fixes

* emit bypass: tag when Jev round-trip throws ([#13](https://github.com/danipl/opencode-jev/issues/13)) ([928c788](https://github.com/danipl/opencode-jev/commit/928c788537afb8a2f000374ea162269aa01c5413)), closes [#6](https://github.com/danipl/opencode-jev/issues/6)
* guard body read and final rebuild so handleRequest never strands a consumed body ([#20](https://github.com/danipl/opencode-jev/issues/20)) ([473d9a1](https://github.com/danipl/opencode-jev/commit/473d9a122681e4d306ed051ed9be4926d5c985ac))

## 1.0.0 (2026-10-03)


### Features

* initial release ([ca9455e](https://github.com/danipl/opencode-jev/commit/ca9455edb2f2e0f22f526aca68ac2e3d99f6cc5a))


### Bug Fixes

* publish pipeline and prepare initial release ([cd698b2](https://github.com/danipl/opencode-jev/commit/cd698b24a00ad20d0a094da5980e5e3d43d7779f))
