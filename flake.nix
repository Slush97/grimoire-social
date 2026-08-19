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
          pkgs = import nixpkgs { inherit system; };
          lib = pkgs.lib;

          nodeVersion = pkgs.nodejs_22.version;
          nodeVersionOk = lib.versionAtLeast nodeVersion "22.12.0";

          # workerd (@cloudflare/workerd-linux-*, npm-fetched, pinned in
          # pnpm-lock.yaml) is a prebuilt dynamically linked binary that
          # needs nix-ld on NixOS. The pinned workerd (1.20260515.1)
          # statically links libc++, so it only needs the glibc family that
          # nix-ld itself supplies as the interpreter; this is a small
          # supplementary library path, not the full Electron-style closure
          # grimoire's devShell needs. Running workerd via wrangler
          # (`pnpm dev`) is the authoritative check, not this list; workerd
          # is a transitive dep of wrangler, so pnpm exposes no workerd bin.
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
              nodejs_22
              # pnpm 10, not the 9 this shell used to pin: nixpkgs removed
              # pnpm_9 on 2026-08-08, so 9 is no longer available to pin.
              # pnpm 10 reads the committed lockfile (lockfileVersion 9.0)
              # as is, and ../grimoire's shell already runs 10. pnpm 10 also
              # gates dependency build scripts, so package.json now lists the
              # three deps that ship one (esbuild, sharp, workerd) under
              # pnpm.onlyBuiltDependencies.
              pnpm_10
              p7zip
              sqlite
              git
              curl
            ];

            shellHook = ''
              # Extend (never replace) the host's nix-ld library path.
              export NIX_LD_LIBRARY_PATH="${lib.makeLibraryPath glibcFamilyLibs}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"

              if ! ${lib.boolToString nodeVersionOk}; then
                echo "ERROR: nodejs_22 (${nodeVersion}) is older than the required 22.12.0." >&2
                echo "  Bump the nixpkgs input." >&2
                exit 1
              fi

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
