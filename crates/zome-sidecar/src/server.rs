use tonic::{Request, Response, Status};
use tracing::info;

use crate::crypto;
use crate::tokenizer;
use crate::vector::VectorIndex;
use crate::zome::zome_sidecar_server::{ZomeSidecar, ZomeSidecarServer};
use crate::zome::{
    EncryptRequest, EncryptResponse, HealthRequest, HealthResponse, SearchRequest, SearchResponse,
    SearchResult, TokenCountRequest, TokenCountResponse, UpsertRequest, UpsertResponse,
};

#[derive(Default)]
pub struct ZomeSidecarService;

#[tonic::async_trait]
impl ZomeSidecar for ZomeSidecarService {
    async fn upsert(
        &self,
        request: Request<UpsertRequest>,
    ) -> Result<Response<UpsertResponse>, Status> {
        let req = request.into_inner();
        let mut index = VectorIndex::new(&req.agent_id);
        index.upsert(&req.doc_id, &req.embedding);
        Ok(Response::new(UpsertResponse {}))
    }

    async fn search(
        &self,
        request: Request<SearchRequest>,
    ) -> Result<Response<SearchResponse>, Status> {
        let req = request.into_inner();
        let index = VectorIndex::new(&req.agent_id);
        let results = index
            .search(&req.query, req.top_k as usize)
            .into_iter()
            .map(|(doc_id, score)| SearchResult { doc_id, score })
            .collect();
        Ok(Response::new(SearchResponse { results }))
    }

    async fn count_tokens(
        &self,
        request: Request<TokenCountRequest>,
    ) -> Result<Response<TokenCountResponse>, Status> {
        let req = request.into_inner();
        let count = tokenizer::count_tokens(&req.text, &req.model);
        Ok(Response::new(TokenCountResponse { count }))
    }

    async fn encrypt(
        &self,
        request: Request<EncryptRequest>,
    ) -> Result<Response<EncryptResponse>, Status> {
        let req = request.into_inner();
        match crypto::encrypt(&req.plaintext) {
            Ok(ciphertext) => Ok(Response::new(EncryptResponse { ciphertext })),
            Err(e) => Err(Status::internal(e.to_string())),
        }
    }

    async fn health(
        &self,
        _request: Request<HealthRequest>,
    ) -> Result<Response<HealthResponse>, Status> {
        Ok(Response::new(HealthResponse {
            status: "ok".to_string(),
        }))
    }
}

pub async fn serve() -> anyhow::Result<()> {
    let addr = "127.0.0.1:50051".parse()?;
    info!("gRPC listening on {}", addr);

    tonic::transport::Server::builder()
        .add_service(ZomeSidecarServer::new(ZomeSidecarService))
        .serve(addr)
        .await?;

    Ok(())
}
