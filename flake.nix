{
    description = "dim-example-rust: a dimOS Desktop app with a Rust server (`nix build .#dimosApp` -> bin/dimos-app-server)";
    inputs = {
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
        # crane builds the dependencies once, in their own derivation, so editing the server only recompiles the server
        # (v0.21: the newest crane that takes nixos-25.05)
        crane.url = "github:ipetkov/crane/v0.21.3";
    };
    outputs = { self, nixpkgs, crane }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAll (pkgs:
                let
                    craneLib = crane.mkLib pkgs;
                    common = {
                        # only what cargo reads, so a frontend or dimos.yaml edit doesn't rebuild the server
                        src = pkgs.lib.fileset.toSource {
                            root = ./.;
                            fileset = pkgs.lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./server ];
                        };
                        strictDeps = true;
                        # the build only builds; `cargo test` runs in development
                        doCheck = false;
                    };
                    # every dependency, compiled against a stub of our code: its hash moves only with Cargo.toml / Cargo.lock
                    # (only crane's `cargo build` pass is reused, so its extra `cargo check` pass is skipped)
                    cargoArtifacts = craneLib.buildDepsOnly (common // { cargoCheckCommand = "true"; });
                in rec {
                    # starts from the dependencies' target dir, so a server edit is a few seconds of compiling
                    server = craneLib.buildPackage (common // {
                        inherit cargoArtifacts;
                        # nothing builds on this target dir, so don't copy it into the output
                        doInstallCargoArtifacts = false;
                    });
                    # Desktop runs `nix build .#dimosApp`; a bin/dimos-app-server is started with DIMOS_APP and proxied at /apps/<name>/
                    dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                        exec ${server}/bin/dim-example-rust --frontend ${./frontend} "$@"
                    '';
                    default = dimosApp;
                });
        };
}
