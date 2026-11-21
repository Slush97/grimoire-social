{
  description = "grimoire-social devShell (contributor tooling, not a deployment mechanism)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
          lib = pkgs.lib;

          # workerd (@cloudflare/workerd-linux-*, npm-fetched, pinned in
          # pnpm-lock.yaml) is a prebuilt dynamically linked binary that
          # needs nix-ld on NixOS. The pinned workerd statically links libc++,
          # so it only needs the glibc family that nix-ld itself supplies as
          # the interpreter; this is a small supplementary library path, not
          # the full Electron-style closure grimoire's devShell needs.
          glibcFamilyLibs = with pkgs; [
            stdenv.cc.cc.lib
            zlib
          ];

          # ELF interpreter path derived per-system, not hardcoded to x86.
          expectedInterpreter =
            if system == "aarch64-linux" then
              "/lib/ld-linux-aarch64.so.1"
            else if system == "x86_64-linux" then
              "/lib64/ld-linux-x86-64.so.2"
            else
              throw "unsupported system: ${system}";
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              pnpm_12
              p7zip
              sqlite
              git
              curl
            ];

            shellHook = ''
              # Extend (never replace) the host's nix-ld library path.
              export NIX_LD_LIBRARY_PATH="${lib.makeLibraryPath glibcFamilyLibs}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"

              echo "== grimoire-social devShell diagnostics =="

              if [ -e "${expectedInterpreter}" ]; then
                echo "  [ok] ELF interpreter present: ${expectedInterpreter}"
              else
                echo "  [warn] ELF interpreter missing: ${expectedInterpreter}"
                echo "         Enable nix-ld on this host: programs.nix-ld.enable = true;"
              fi

              if [ ! -f ".dev.vars" ] && [ -f ".dev.vars.example" ]; then
                echo "  [note] .dev.vars not found; copy .dev.vars.example to get started."
              fi

              echo ""
              echo "First-run commands:"
              echo "  pnpm install --frozen-lockfile"
              echo "  pnpm exec wrangler --version"
              echo "  cp .dev.vars.example .dev.vars   # fill in STEAM_API_KEY, ADMIN_TOKEN"
              echo "  pnpm db:migrate:local"
              echo "  pnpm dev"
            '';
          };
        }
      );
    };
}
