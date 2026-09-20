{ pkgs, lib, config, ... }:

let
  # npm's workerd executable targets a conventional Linux loader. Run the
  # lockfile-selected binary with Nix libraries without patching node_modules.
  workerdLauncher = pkgs.writeShellScript "apron-workerd" ''
    set -eu
    workerd_binary="$(${config.languages.javascript.package}/bin/node -e 'const { createRequire } = require("node:module"); process.stdout.write(createRequire(process.argv[1])("workerd").default)' ${lib.escapeShellArg "${config.devenv.root}/servers/cloudflare-worker/package.json"})"
    exec ${pkgs.stdenv.cc.bintools.dynamicLinker} \
      --library-path ${lib.makeLibraryPath [ pkgs.glibc pkgs.stdenv.cc.cc.lib ]} \
      "$workerd_binary" "$@"
  '';
in {
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
  };
  languages.go = {
    enable = true;
    package = pkgs.go_1_26;
  };

  packages = [ pkgs.git pkgs.gnumake pkgs.stdenv.cc ];

  # Use a Nix-patched browser on Linux, including NixOS.
  env = lib.optionalAttrs pkgs.stdenv.isLinux {
    MINIFLARE_WORKERD_PATH = "${workerdLauncher}";
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH =
      "${pkgs.playwright-driver.components.chromium}/${if pkgs.stdenv.hostPlatform.isx86_64 then "chrome-linux64" else "chrome-linux"}/chrome";
  };

  # Playwright owns these ports during tests.
  processes = lib.optionalAttrs (!config.devenv.isTesting) {
    server.exec = "make dev-server";
    web.exec = "make dev-web";
  };

  enterTest = ''
    make check test build test-interop
  '';
}
