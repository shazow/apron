{ pkgs, lib, config, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
  };
  languages.go = {
    enable = true;
    package = pkgs.go_1_27;
  };

  packages = [ pkgs.git pkgs.gnumake pkgs.stdenv.cc ];

  # Use a Nix-patched browser on Linux, including NixOS.
  env = lib.optionalAttrs pkgs.stdenv.isLinux {
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
