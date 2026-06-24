fn main() {
    tonic_build::compile_protos("proto/zome.proto").expect("Failed to compile protos");
}
