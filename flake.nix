{
    description = "dim-example-rust: a dimOS Desktop app with a Rust server (`nix build .#dimosApp` -> bin/dimos-app-server)";
    inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    outputs = { self, nixpkgs }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
        in {
            packages = forAll (pkgs: rec {
                server = pkgs.rustPlatform.buildRustPackage {
                    pname = "dim-example-rust";
                    version = "0.1.0";
                    src = pkgs.lib.cleanSourceWith { src = ./.; filter = path: type: !(pkgs.lib.hasInfix "/target" path); };
                    cargoLock.lockFile = ./Cargo.lock;
                };
                # Desktop runs `nix build .#dimosApp`; a bin/dimos-app-server is started with DIMOS_APP and proxied at /apps/<name>/
                dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
                    exec ${server}/bin/dim-example-rust --frontend ${./frontend} "$@"
                '';
                default = dimosApp;
            });
        };
}
